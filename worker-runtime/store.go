package workerqueue

import (
	"context"
	"crypto/sha256"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Job struct {
	ID             string
	Body           []byte
	EnqueuedAt     time.Time
	Attempt        int
	TimestampKnown bool
}

func NewJob(id string, body []byte, enqueued time.Time) Job {
	known := !enqueued.IsZero()
	if id == "" {
		id = fmt.Sprintf("legacy-%x", sha256.Sum256(body))
	}
	if enqueued.IsZero() {
		enqueued = time.Now().UTC()
	}
	return Job{ID: id, Body: body, EnqueuedAt: enqueued.UTC(), TimestampKnown: known}
}

type claim struct {
	State     string
	Attempts  int
	Wait      time.Duration
	ErrorCode string
}
type Store struct {
	DB    *pgxpool.Pool
	Queue string
}

// A database lease and attempt count survive process/broker restarts. Redelivery
// never resets the budget; notification contents/credentials are not stored here.
func (s Store) Claim(ctx context.Context, j Job, c Config) (claim, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return claim{}, err
	}
	defer tx.Rollback(ctx)
	hash := fmt.Sprintf("%x", sha256.Sum256(j.Body))
	_, err = tx.Exec(ctx, `INSERT INTO worker_jobs(queue_name,job_id,body_hash,enqueued_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, s.Queue, j.ID, hash, j.EnqueuedAt)
	if err != nil {
		return claim{}, err
	}
	var r claim
	var stored string
	var lease, next *time.Time
	var now time.Time
	err = tx.QueryRow(ctx, `SELECT state,attempts,body_hash,lease_until,next_attempt_at,COALESCE(last_error_code,'') FROM worker_jobs WHERE queue_name=$1 AND job_id=$2 FOR UPDATE`, s.Queue, j.ID).Scan(&r.State, &r.Attempts, &stored, &lease, &next, &r.ErrorCode)
	if err != nil {
		return r, err
	}
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return r, err
	}
	if stored != hash {
		return r, Permanent("IDENTITY_PAYLOAD_MISMATCH")
	}
	if r.State == "SUCCEEDED" || r.State == "DEAD_LETTER" || r.State == "DEAD_LETTER_PENDING" {
		return r, tx.Commit(ctx)
	}
	if r.State == "RUNNING" && lease != nil && now.Before(*lease) {
		r.Wait = lease.Sub(now)
		return r, tx.Commit(ctx)
	}
	if r.State == "RETRYING" && next != nil && now.Before(*next) {
		r.Wait = next.Sub(now)
		return r, tx.Commit(ctx)
	}
	if r.Attempts >= c.MaxAttempts {
		r.State = "DEAD_LETTER_PENDING"
		r.ErrorCode = "ATTEMPTS_EXHAUSTED"
		_, err = tx.Exec(ctx, `UPDATE worker_jobs SET state=$3,last_error_code='ATTEMPTS_EXHAUSTED',lease_until=NULL,updated_at=clock_timestamp() WHERE queue_name=$1 AND job_id=$2`, s.Queue, j.ID, r.State)
	} else {
		r.Attempts++
		r.State = "RUNNING"
		_, err = tx.Exec(ctx, `UPDATE worker_jobs SET state=$3,attempts=$4,lease_until=clock_timestamp()+$5::interval,next_attempt_at=NULL,updated_at=clock_timestamp() WHERE queue_name=$1 AND job_id=$2`, s.Queue, j.ID, r.State, r.Attempts, (c.Timeout + c.PublishTimeout + time.Second).String())
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	return r, err
}
func (s Store) Succeeded(ctx context.Context, id string, attempt int) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = complete(ctx, tx, s.Queue, id, attempt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type completionKey struct{}
type completionScope struct {
	queue, id string
	attempt   int
}

// Workers may commit their result/audit and execution completion atomically.
// Direct domain tests without a queue execution scope remain independent.
func CompleteInTransaction(ctx context.Context, tx pgx.Tx) error {
	scope, ok := ctx.Value(completionKey{}).(completionScope)
	if !ok {
		return nil
	}
	return complete(ctx, tx, scope.queue, scope.id, scope.attempt)
}
func complete(ctx context.Context, tx pgx.Tx, queue, id string, attempt int) error {
	tag, err := tx.Exec(ctx, `UPDATE worker_jobs SET state='SUCCEEDED',lease_until=NULL,next_attempt_at=NULL,last_error_code=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE queue_name=$1 AND job_id=$2 AND attempts=$3 AND state='RUNNING'`, queue, id, attempt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var state string
	var actual int
	err = tx.QueryRow(ctx, `SELECT state,attempts FROM worker_jobs WHERE queue_name=$1 AND job_id=$2`, queue, id).Scan(&state, &actual)
	if err == nil && state == "SUCCEEDED" && actual == attempt {
		return nil
	}
	return fmt.Errorf("job lease changed")
}
func (s Store) Failed(ctx context.Context, id string, r claim, c Config, code string, permanent bool) (string, error) {
	state := "RETRYING"
	if permanent || r.Attempts >= c.MaxAttempts {
		state = "DEAD_LETTER_PENDING"
	}
	tag, err := s.DB.Exec(ctx, `UPDATE worker_jobs SET state=$4,last_error_code=$5,lease_until=NULL,next_attempt_at=CASE WHEN $4='RETRYING' THEN clock_timestamp()+$6::interval ELSE NULL END,updated_at=clock_timestamp() WHERE queue_name=$1 AND job_id=$2 AND attempts=$3 AND state='RUNNING'`, s.Queue, id, r.Attempts, state, code, c.delay(r.Attempts).String())
	if err == nil && tag.RowsAffected() != 1 {
		return state, fmt.Errorf("job lease changed")
	}
	return state, err
}
func (s Store) DeadLettered(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `UPDATE worker_jobs SET state='DEAD_LETTER',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE queue_name=$1 AND job_id=$2 AND state='DEAD_LETTER_PENDING'`, s.Queue, id)
	return err
}

type permanentError string

func (e permanentError) Error() string { return string(e) }
func Permanent(code string) error      { return permanentError(code) }
