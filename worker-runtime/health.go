package workerqueue

import (
	"context"
	"encoding/json"
	"fmt"
	amqp "github.com/rabbitmq/amqp091-go"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type Snapshot struct {
	Connections       int       `json:"connections_total"`
	MaxAttempts       int       `json:"max_attempts"`
	TimeoutSeconds    float64   `json:"processing_timeout_seconds"`
	Queue             string    `json:"queue"`
	Ready             bool      `json:"ready"`
	BrokerConnected   bool      `json:"broker_connected"`
	DatabaseAvailable bool      `json:"database_available"`
	ReadyMessages     int       `json:"ready_messages"`
	RetryMessages     int       `json:"retry_messages"`
	DeadMessages      int       `json:"dead_letter_messages"`
	FailedJobs        int64     `json:"failed_jobs"`
	CompletedJobs     int64     `json:"completed_jobs"`
	LeasedJobs        int64     `json:"leased_jobs"`
	OldestPendingAge  float64   `json:"oldest_pending_job_age_seconds"`
	QueueAge          *float64  `json:"queue_age_seconds"`
	CheckedAt         time.Time `json:"checked_at"`
	Alerts            []string  `json:"alerts"`
}
type healthState struct {
	mu          sync.RWMutex
	snapshot    Snapshot
	connections int
}

func (s *healthState) connected() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot.BrokerConnected = true
	s.connections++
}
func (s *healthState) disconnected() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot.BrokerConnected = false
	s.snapshot.Ready = false
}
func (s *healthState) read() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r := s.snapshot
	r.Connections = s.connections
	r.Alerts = append([]string{}, r.Alerts...)
	if !r.BrokerConnected {
		r.Alerts = append(r.Alerts, "BROKER_DISCONNECTED")
	}
	return r
}
func (r *Runner) healthHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(r.health.read())
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		s := r.health.read()
		w.Header().Set("Content-Type", "application/json")
		if !s.Ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		json.NewEncoder(w).Encode(s)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		s := r.health.read()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		label := fmt.Sprintf("{queue=%q}", r.Config.Queue)
		ready := 0
		if s.Ready {
			ready = 1
		}
		fmt.Fprintf(w, "worker_ready%s %d\nworker_queue_ready%s %d\nworker_queue_retry%s %d\nworker_dead_letters%s %d\nworker_failed_jobs%s %d\nworker_completed_jobs%s %d\nworker_oldest_pending_job_age_seconds%s %g\n", label, ready, label, s.ReadyMessages, label, s.RetryMessages, label, s.DeadMessages, label, s.FailedJobs, label, s.CompletedJobs, label, s.OldestPendingAge)
		if s.QueueAge != nil {
			fmt.Fprintf(w, "worker_queue_age_seconds%s %g\n", label, *s.QueueAge)
		}
	})
	return mux
}
func (r *Runner) observeLoop(ctx context.Context, ch *amqp.Channel) {
	tick := time.NewTicker(r.Config.MonitorInterval)
	defer tick.Stop()
	for {
		r.observe(ctx, ch)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
func (r *Runner) observe(ctx context.Context, ch *amqp.Channel) {
	s := Snapshot{Queue: r.Config.Queue, MaxAttempts: r.Config.MaxAttempts, TimeoutSeconds: r.Config.Timeout.Seconds(), Alerts: []string{}, CheckedAt: time.Now().UTC()}
	q, err := ch.QueueInspect(r.Config.Queue)
	s.BrokerConnected = err == nil
	s.ReadyMessages = q.Messages
	counts := map[string]int{r.Config.Queue: q.Messages}
	if err == nil {
		dead, e := ch.QueueInspect(r.Config.Queue + ".dead")
		if e == nil {
			s.DeadMessages = dead.Messages
		} else {
			s.BrokerConnected = false
		}
	}
	names := []string{r.Config.Queue}
	seen := map[string]bool{}
	for _, delay := range r.Config.RetryDelays {
		name := r.Config.retryQueue(delay)
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
		q, e := ch.QueueInspect(name)
		if e == nil {
			s.RetryMessages += q.Messages
			counts[name] = q.Messages
		} else {
			s.BrokerConnected = false
		}
	}
	dbCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	err = r.Store.DB.QueryRow(dbCtx, `SELECT count(*) FILTER(WHERE attempts>1 OR last_error_code IS NOT NULL),count(*) FILTER(WHERE state='SUCCEEDED'),COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(enqueued_at) FILTER(WHERE state NOT IN ('SUCCEEDED','DEAD_LETTER'))),0),count(*) FILTER(WHERE state='RUNNING' AND lease_until>clock_timestamp()) FROM worker_jobs WHERE queue_name=$1`, r.Config.Queue).Scan(&s.FailedJobs, &s.CompletedJobs, &s.OldestPendingAge, &s.LeasedJobs)
	cancel()
	s.DatabaseAvailable = err == nil
	s.Ready = s.BrokerConnected && s.DatabaseAvailable
	if !s.DatabaseAvailable {
		s.Alerts = append(s.Alerts, "DATABASE_UNAVAILABLE")
	}
	if s.DeadMessages > 0 {
		s.Alerts = append(s.Alerts, "DEAD_LETTERS_PRESENT")
	}
	if s.BrokerConnected {
		age, ageErr := r.queueAge(ctx, names, counts)
		if ageErr == nil {
			s.QueueAge = &age
		} else {
			s.Alerts = append(s.Alerts, "QUEUE_AGE_UNAVAILABLE")
		}
	}
	if s.OldestPendingAge >= r.Config.AgeWarning.Seconds() || (s.QueueAge != nil && *s.QueueAge >= r.Config.AgeWarning.Seconds()) {
		s.Alerts = append(s.Alerts, "QUEUE_AGE_HIGH")
	}
	if ctx.Err() != nil {
		return
	}
	r.health.mu.Lock()
	if ctx.Err() != nil {
		r.health.mu.Unlock()
		return
	}
	previous := r.health.snapshot.Alerts
	r.health.snapshot = s
	r.health.mu.Unlock()
	old := map[string]bool{}
	for _, alert := range previous {
		old[alert] = true
	}
	for _, alert := range s.Alerts {
		if !old[alert] {
			r.event("health_alert", "", alert, 0)
		}
		delete(old, alert)
	}
	for alert := range old {
		r.event("health_alert_recovered", "", alert, 0)
	}
}

// Management metadata reads head timestamps without consuming/requeueing jobs.
// Missing legacy timestamps or an unavailable management API are explicit unknowns.
func (r *Runner) queueAge(ctx context.Context, names []string, counts map[string]int) (float64, error) {
	queued := 0
	for _, count := range counts {
		queued += count
	}
	if queued == 0 {
		return 0, nil
	}
	if r.Config.ManagementURL == "" {
		return 0, fmt.Errorf("management endpoint not configured")
	}
	broker, err := amqp.ParseURI(r.Config.BrokerURL)
	if err != nil {
		return 0, err
	}
	oldest := 0.0
	for _, name := range names {
		if counts[name] == 0 {
			continue
		}
		requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		req, err := http.NewRequestWithContext(requestCtx, "GET", r.Config.ManagementURL+"/api/queues/"+url.PathEscape(broker.Vhost)+"/"+url.PathEscape(name), nil)
		if err != nil {
			cancel()
			return 0, err
		}
		req.SetBasicAuth(broker.Username, broker.Password)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			return 0, err
		}
		var data struct {
			Messages int      `json:"messages_ready"`
			Head     *float64 `json:"head_message_timestamp"`
		}
		err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&data)
		response.Body.Close()
		cancel()
		if response.StatusCode != http.StatusOK || err != nil {
			return 0, fmt.Errorf("queue metadata unavailable")
		}
		if data.Messages == 0 {
			return 0, fmt.Errorf("queue metadata lags current counts")
		}
		if data.Head == nil {
			return 0, fmt.Errorf("legacy queue timestamp unknown")
		}
		stamp := *data.Head
		if stamp > 1e11 {
			stamp /= 1000
		}
		age := float64(time.Now().Unix()) - stamp
		if age > oldest {
			oldest = age
		}
	}
	return oldest, nil
}
