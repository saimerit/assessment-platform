package workerqueue

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"
)

func TestDurableExecutionBudget(t *testing.T) {
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("run scripts/test-attempt-access.ps1")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/assessment_attempt_auth_test" {
		t.Fatal("requires disposable test database")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	c, _ := LoadConfig("worker-test", "amqp://guest:guest@localhost/")
	c.MaxAttempts = 3
	var suffix string
	if err = db.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&suffix); err != nil {
		t.Fatal(err)
	}
	store := Store{db, "test-" + suffix}
	j := NewJob("budget", []byte(`{"private":"not stored"}`), time.Now())
	claims := make(chan claim, 8)
	failures := make(chan error, 8)
	var wait sync.WaitGroup
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			r, e := store.Claim(ctx, j, c)
			if e != nil {
				failures <- e
			} else {
				claims <- r
			}
		}()
	}
	wait.Wait()
	close(claims)
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	actual := 0
	for r := range claims {
		if r.Attempts != 1 {
			t.Fatal("duplicate increased budget")
		}
		if r.Wait == 0 {
			actual++
		}
	}
	if actual != 1 {
		t.Fatal("concurrent duplicate acquired another execution lease")
	}
	r := claim{State: "RUNNING", Attempts: 1}
	for attempt := 1; attempt <= 3; attempt++ {
		state, e := store.Failed(ctx, j.ID, r, c, "PROCESSING_FAILED", false)
		if e != nil {
			t.Fatal(e)
		}
		if attempt == 3 {
			if state != "DEAD_LETTER_PENDING" {
				t.Fatal("exhaustion did not await durable dead-letter confirmation")
			}
			break
		}
		deferred, e := store.Claim(ctx, j, c)
		if e != nil || deferred.Wait <= 0 || deferred.Attempts != attempt {
			t.Fatal("retry ran before its stored deadline", e)
		}
		if _, e = db.Exec(ctx, `UPDATE worker_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE queue_name=$1 AND job_id=$2`, store.Queue, j.ID); e != nil {
			t.Fatal(e)
		}
		// A new store instance represents a worker restart; counts must persist.
		r, e = (Store{db, store.Queue}).Claim(ctx, j, c)
		if e != nil || r.Attempts != attempt+1 {
			t.Fatal("restart reset attempt budget", e)
		}
	}
	if err = store.DeadLettered(ctx, j.ID); err != nil {
		t.Fatal(err)
	}
	terminal, err := store.Claim(ctx, j, c)
	if err != nil || terminal.State != "DEAD_LETTER" || terminal.Attempts != 3 {
		t.Fatal("dead-letter job processed again", err)
	}
	_, err = store.Claim(ctx, NewJob(j.ID, []byte("changed"), j.EnqueuedAt), c)
	var permanent permanentError
	if !errors.As(err, &permanent) {
		t.Fatal("changed payload reused a job identity")
	}
}

func TestAtomicCompletionAndTimeout(t *testing.T) {
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("run scripts/test-attempt-access.ps1")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/assessment_attempt_auth_test" {
		t.Fatal("requires disposable test database")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	c, _ := LoadConfig("worker-test", "amqp://guest:guest@localhost/")
	var suffix string
	_ = db.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&suffix)
	store := Store{db, "test-" + suffix}
	j := NewJob("atomic", []byte("body"), time.Now())
	r, err := store.Claim(ctx, j, c)
	if err != nil {
		t.Fatal(err)
	}
	scoped := context.WithValue(ctx, completionKey{}, completionScope{store.Queue, j.ID, r.Attempts})
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = CompleteInTransaction(scoped, tx); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	r, err = store.Claim(ctx, j, c)
	if err != nil || r.State != "RUNNING" || r.Wait <= 0 {
		t.Fatal("rollback published successful completion", err)
	}
	tx, _ = db.Begin(ctx)
	if err = CompleteInTransaction(scoped, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = store.Succeeded(ctx, j.ID, 1); err != nil {
		t.Fatal("atomic handler completion was not idempotent", err)
	}
	r, err = store.Claim(ctx, j, c)
	if err != nil || r.State != "SUCCEEDED" || r.Attempts != 1 {
		t.Fatal("completed job executed again", err)
	}
	tx, _ = db.Begin(ctx)
	if _, err = tx.Exec(ctx, `SELECT job_id FROM worker_jobs WHERE queue_name=$1 FOR UPDATE`, store.Queue); err != nil {
		t.Fatal(err)
	}
	deadline, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	_, err = store.Claim(deadline, j, c)
	_ = tx.Rollback(ctx)
	if err == nil {
		t.Fatal("lock wait ignored processing context deadline")
	}
}
