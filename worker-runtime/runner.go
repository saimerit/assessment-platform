package workerqueue

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type Runner struct {
	Config  Config
	Store   Store
	Handler func(context.Context, Job) error
	health  healthState
}

func New(c Config, db *pgxpool.Pool, handler func(context.Context, Job) error) *Runner {
	return &Runner{Config: c, Store: Store{db, c.Queue}, Handler: handler}
}
func (r *Runner) event(event, id, code string, attempt int) {
	body, _ := json.Marshal(map[string]any{"event": event, "queue": r.Config.Queue, "job_id": id, "attempt": attempt, "error_code": code})
	log.Print(string(body))
}

func (r *Runner) Run(ctx context.Context) error {
	listener, err := net.Listen("tcp", r.Config.HealthAddress)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: r.healthHandler(), ReadHeaderTimeout: 3 * time.Second}
	defer server.Close()
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			r.event("health_server_failed", "", "HEALTH_UNAVAILABLE", 0)
		}
	}()
	backoff := time.Second
	for ctx.Err() == nil {
		err = r.session(ctx)
		r.health.disconnected()
		if ctx.Err() != nil {
			break
		}
		r.event("consumer_reconnecting", "", "BROKER_CONNECTION_UNAVAILABLE", 0)
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		if backoff < 10*time.Second {
			backoff *= 2
			if backoff > 10*time.Second {
				backoff = 10 * time.Second
			}
		}
	}
	return nil
}

func declare(ch *amqp.Channel, c Config) error {
	if _, err := ch.QueueDeclare(c.Queue, true, false, false, false, nil); err != nil {
		return err
	}
	if _, err := ch.QueueDeclare(c.Queue+".dead", true, false, false, false, amqp.Table{"x-queue-type": "quorum"}); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, delay := range c.RetryDelays {
		name := c.retryQueue(delay)
		if seen[name] {
			continue
		}
		seen[name] = true
		_, err := ch.QueueDeclare(name, true, false, false, false, amqp.Table{
			"x-queue-type": "quorum", "x-message-ttl": int64(delay.Milliseconds()),
			"x-dead-letter-exchange": "", "x-dead-letter-routing-key": c.Queue,
			"x-dead-letter-strategy": "at-least-once", "x-overflow": "reject-publish"})
		if err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) session(ctx context.Context) error {
	conn, err := amqp.DialConfig(r.Config.BrokerURL, amqp.Config{Heartbeat: 5 * time.Second, Dial: amqp.DefaultDial(3 * time.Second)})
	if err != nil {
		return err
	}
	defer conn.Close()
	consumer, err := conn.Channel()
	if err != nil {
		return err
	}
	defer consumer.Close()
	if err = declare(consumer, r.Config); err != nil {
		return err
	}
	if err = consumer.Qos(1, 0, false); err != nil {
		return err
	}
	publisher, err := conn.Channel()
	if err != nil {
		return err
	}
	defer publisher.Close()
	if err = publisher.Confirm(false); err != nil {
		return err
	}
	returns := publisher.NotifyReturn(make(chan amqp.Return, 1))
	monitor, err := conn.Channel()
	if err != nil {
		return err
	}
	defer monitor.Close()
	deliveries, err := consumer.Consume(r.Config.Queue, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	connectionClosed := conn.NotifyClose(make(chan *amqp.Error, 1))
	channelClosed := consumer.NotifyClose(make(chan *amqp.Error, 1))
	go func() {
		select {
		case <-sessionCtx.Done():
		case <-connectionClosed:
			cancel()
			r.health.disconnected()
		case <-channelClosed:
			cancel()
			r.health.disconnected()
		}
	}()
	r.health.connected()
	r.event("consumer_connected", "", "", 0)
	monitored := make(chan struct{})
	go func() { defer close(monitored); r.observeLoop(sessionCtx, monitor) }()
	defer func() { cancel(); <-monitored }()
	publish := func(target string, j Job, attempt int, code string) error {
		stamp := j.EnqueuedAt
		if !j.TimestampKnown {
			stamp = time.Time{}
		}
		publishCtx, done := context.WithTimeout(sessionCtx, r.Config.PublishTimeout)
		defer done()
		confirmation, publishErr := publisher.PublishWithDeferredConfirmWithContext(publishCtx, "", target, true, false, amqp.Publishing{
			MessageId: j.ID, ContentType: "application/json", DeliveryMode: amqp.Persistent, Timestamp: stamp,
			Headers: amqp.Table{"worker-attempt": int32(attempt), "worker-error-code": code}, Body: j.Body})
		if publishErr != nil {
			return publishErr
		}
		accepted, publishErr := confirmation.WaitContext(publishCtx)
		if publishErr != nil {
			return publishErr
		}
		if !accepted {
			return errors.New("publication rejected")
		}
		select {
		case returned := <-returns:
			if returned.ReplyCode != 0 {
				return errors.New("publication unroutable")
			}
		default:
		}
		return nil
	}
	for {
		select {
		case <-sessionCtx.Done():
			return sessionCtx.Err()
		case delivery, open := <-deliveries:
			if !open {
				return errors.New("consumer channel closed")
			}
			if err = r.process(sessionCtx, delivery, publish); err != nil {
				return err
			}
		}
	}
}

func (r *Runner) process(ctx context.Context, d amqp.Delivery, publish func(string, Job, int, string) error) error {
	j := NewJob(d.MessageId, d.Body, d.Timestamp)
	if len(j.ID) > 255 || !utf8.ValidString(j.ID) || strings.ContainsRune(j.ID, '\x00') {
		j.ID = fmt.Sprintf("invalid-%x", sha256.Sum256([]byte(j.ID)))
		if err := publish(r.Config.Queue+".dead", j, 0, "INVALID_JOB_IDENTITY"); err != nil {
			return err
		}
		return d.Ack(false)
	}
	if len(j.Body) > 1<<20 {
		if err := publish(r.Config.Queue+".dead", j, 0, "PAYLOAD_LIMIT"); err != nil {
			return err
		}
		return d.Ack(false)
	}
	dbCtx, done := context.WithTimeout(ctx, r.Config.PublishTimeout)
	state, err := r.Store.Claim(dbCtx, j, r.Config)
	done()
	if err != nil {
		var permanent permanentError
		if !errors.As(err, &permanent) {
			return err
		}
		if err = publish(r.Config.Queue+".dead", j, 0, string(permanent)); err != nil {
			return err
		}
		return d.Ack(false)
	}
	if state.State == "SUCCEEDED" || state.State == "DEAD_LETTER" {
		r.event("duplicate_skipped", j.ID, "", state.Attempts)
		return d.Ack(false)
	}
	if state.Wait > 0 {
		if err = publish(r.Config.retryQueue(state.Wait), j, state.Attempts, "LEASE_OR_RETRY_PENDING"); err != nil {
			return err
		}
		return d.Ack(false)
	}
	if state.State != "DEAD_LETTER_PENDING" {
		r.event("processing", j.ID, "", state.Attempts)
		jobCtx, cancel := context.WithTimeout(ctx, r.Config.Timeout)
		jobCtx = context.WithValue(jobCtx, completionKey{}, completionScope{r.Config.Queue, j.ID, state.Attempts})
		j.Attempt = state.Attempts
		err = r.call(jobCtx, j)
		if jobCtx.Err() != nil {
			err = jobCtx.Err()
		}
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		dbCtx, done = context.WithTimeout(ctx, r.Config.PublishTimeout)
		if err == nil {
			err = r.Store.Succeeded(dbCtx, j.ID, state.Attempts)
			done()
			if err != nil {
				return err
			}
			r.event("succeeded", j.ID, "", state.Attempts)
			return d.Ack(false)
		}
		code := "PROCESSING_FAILED"
		var permanent permanentError
		isPermanent := errors.As(err, &permanent)
		if isPermanent {
			code = string(permanent)
		} else if errors.Is(err, context.DeadlineExceeded) {
			code = "PROCESSING_TIMEOUT"
		}
		state.State, err = r.Store.Failed(dbCtx, j.ID, state, r.Config, code, isPermanent)
		state.ErrorCode = code
		done()
		if err != nil {
			return err
		}
		r.event("processing_failed", j.ID, code, state.Attempts)
		if state.State == "RETRYING" {
			if err = publish(r.Config.retryQueue(r.Config.delay(state.Attempts)), j, state.Attempts, code); err != nil {
				return err
			}
			return d.Ack(false)
		}
	}
	if err = publish(r.Config.Queue+".dead", j, state.Attempts, state.ErrorCode); err != nil {
		return err
	}
	dbCtx, done = context.WithTimeout(ctx, r.Config.PublishTimeout)
	err = r.Store.DeadLettered(dbCtx, j.ID)
	done()
	if err != nil {
		return err
	}
	r.event("dead_lettered", j.ID, "", state.Attempts)
	return d.Ack(false)
}
func (r *Runner) call(ctx context.Context, j Job) (err error) {
	defer func() {
		if recover() != nil {
			err = fmt.Errorf("processor panic")
		}
	}()
	return r.Handler(ctx, j)
}
