package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"log"
	"time"

	"assessment/workerqueue"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"os/signal"
	"syscall"
)

type AssessmentSubmittedEvent struct {
	SubmissionID string    `json:"submission_id,omitempty"`
	Version      int       `json:"version,omitempty"`
	InstanceID   string    `json:"instance_id"`
	SessionID    string    `json:"session_id,omitempty"`
	StudentID    string    `json:"student_id"`
	BlueprintID  string    `json:"blueprint_id"`
	SubmittedAt  time.Time `json:"submitted_at"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dbpool, err := pgxpool.New(ctx, requiredEnv("GRADING_DATABASE_URL"))
	if err != nil {
		log.Fatal("Invalid grading database configuration")
	}
	defer dbpool.Close()
	cfg, err := workerqueue.LoadConfig("assessment_submissions", requiredEnv("RABBITMQ_URL"))
	if err != nil {
		log.Fatal(err)
	}
	runner := workerqueue.New(cfg, dbpool, func(ctx context.Context, job workerqueue.Job) error {
		var event AssessmentSubmittedEvent
		if json.Unmarshal(job.Body, &event) != nil {
			return workerqueue.Permanent("INVALID_PAYLOAD")
		}
		if event.SubmissionID != "" {
			if !validUUID(event.SubmissionID) || event.Version != 1 {
				return workerqueue.Permanent("INVALID_SUBMISSION_VERSION")
			}
		} else if event.Version != 0 || (event.SessionID == "" && event.InstanceID == "") {
			return workerqueue.Permanent("INVALID_SUBMISSION_IDENTITY")
		}
		for _, id := range []string{event.SessionID, event.InstanceID, event.StudentID, event.BlueprintID} {
			if id != "" && !validUUID(id) {
				return workerqueue.Permanent("INVALID_SUBMISSION_IDENTITY")
			}
		}
		return evaluateSubmission(ctx, dbpool, event)
	})
	if err := runner.Run(ctx); err != nil {
		log.Fatal(err)
	}
}
func validUUID(id string) bool { var value pgtype.UUID; return value.Scan(id) == nil && value.Valid }

func evaluateSubmission(ctx context.Context, db *pgxpool.Pool, event AssessmentSubmittedEvent) error {
	if event.SubmissionID != "" {
		return evaluateFrozenSubmission(ctx, db, event)
	}
	if event.Version != 0 {
		return errors.New("Versioned grading requires a submission identity")
	}
	// Legacy queue messages wait for the API's durable recovery record. Never
	// grade mutable current question definitions while a snapshot is missing.
	var id string
	var version int
	err := db.QueryRow(ctx, `SELECT id::text,version FROM attempt_submissions WHERE session_id=NULLIF($1,'')::uuid OR instance_id=NULLIF($2,'')::uuid`, event.SessionID, event.InstanceID).Scan(&id, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("Submission awaits durable recovery")
	}
	if err != nil {
		return err
	}
	event.SubmissionID = id
	event.Version = version
	return evaluateFrozenSubmission(ctx, db, event)
}
