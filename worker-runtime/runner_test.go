package workerqueue

import (
	"context"
	"errors"
	amqp "github.com/rabbitmq/amqp091-go"
	"strings"
	"testing"
)

type testAcknowledgment struct{ acks int }

func (a *testAcknowledgment) Ack(uint64, bool) error        { a.acks++; return nil }
func (a *testAcknowledgment) Nack(uint64, bool, bool) error { return nil }
func (a *testAcknowledgment) Reject(uint64, bool) error     { return nil }

func TestPoisonEnvelopeAcknowledgment(t *testing.T) {
	c, _ := LoadConfig("grade", "amqp://guest:guest@localhost/")
	r := Runner{Config: c}
	a := &testAcknowledgment{}
	d := amqp.Delivery{MessageId: "invalid\x00identity", Body: []byte("{}"), Acknowledger: a}
	err := r.process(context.Background(), d, func(target string, j Job, attempt int, code string) error {
		if target != "grade.dead" || strings.ContainsRune(j.ID, '\x00') || code != "INVALID_JOB_IDENTITY" {
			t.Fatal("invalid envelope was not safely quarantined")
		}
		return errors.New("broker confirmation lost")
	})
	if err == nil || a.acks != 0 {
		t.Fatal("unconfirmed dead letter discarded original delivery")
	}
	err = r.process(context.Background(), d, func(string, Job, int, string) error { return nil })
	if err != nil || a.acks != 1 {
		t.Fatal("confirmed quarantine did not acknowledge poison input", err)
	}
}
