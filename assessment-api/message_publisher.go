package main

import (
	"context"
	"errors"
	amqp "github.com/rabbitmq/amqp091-go"
	"sync"
	"time"
)

type messagePublisher interface {
	Publish(context.Context, string, string, []byte) error
}

// One channel owner serializes confirms and mandatory-return handling. Any
// failed/closed connection is discarded; the next durable outbox retry reconnects.
type RabbitPublisher struct {
	url     string
	mu      sync.Mutex
	conn    *amqp.Connection
	channel *amqp.Channel
	returns chan amqp.Return
}

func (p *RabbitPublisher) closeLocked() {
	if p.channel != nil {
		_ = p.channel.Close()
	}
	if p.conn != nil {
		_ = p.conn.Close()
	}
	p.channel = nil
	p.conn = nil
}
func (p *RabbitPublisher) Close() { p.mu.Lock(); defer p.mu.Unlock(); p.closeLocked() }
func (p *RabbitPublisher) connect() error {
	if p.conn != nil && !p.conn.IsClosed() && p.channel != nil && !p.channel.IsClosed() {
		return nil
	}
	p.closeLocked()
	conn, err := amqp.DialConfig(p.url, amqp.Config{Heartbeat: 10 * time.Second, Dial: amqp.DefaultDial(3 * time.Second)})
	if err != nil {
		return err
	}
	p.conn = conn
	ch, err := conn.Channel()
	if err != nil {
		p.closeLocked()
		return err
	}
	p.channel = ch
	for _, queue := range []string{"assessment_submissions", "notification_events"} {
		if _, err = ch.QueueDeclare(queue, true, false, false, false, nil); err != nil {
			p.closeLocked()
			return err
		}
	}
	if err = ch.Confirm(false); err != nil {
		p.closeLocked()
		return err
	}
	p.returns = ch.NotifyReturn(make(chan amqp.Return, 1))
	return nil
}
func (p *RabbitPublisher) Publish(ctx context.Context, queue, id string, body []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := p.connect(); err != nil {
		return err
	}
	confirmation, err := p.channel.PublishWithDeferredConfirmWithContext(ctx, "", queue, true, false, amqp.Publishing{MessageId: id, ContentType: "application/json", DeliveryMode: amqp.Persistent, Timestamp: time.Now().UTC(), Body: body})
	if err == nil {
		var accepted bool
		accepted, err = confirmation.WaitContext(ctx)
		if err == nil && !accepted {
			err = errors.New("Broker rejected publication")
		}
	}
	if err == nil {
		select {
		case returned := <-p.returns:
			if returned.ReplyCode != 0 {
				err = errors.New("Broker could not route publication")
			}
		default:
		}
	}
	if err != nil {
		p.closeLocked()
	}
	return err
}
