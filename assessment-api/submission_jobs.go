package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"log"
	"time"
)

func (s *Server) finalizeOne(ctx context.Context, a attemptRecord, recover bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	l, err := loadLifecycle(ctx, tx, a, true)
	if err != nil {
		return err
	}
	if _, err = readSubmissionReceipt(ctx, tx, a); err == nil {
		return tx.Commit(ctx)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	now, err := attemptNow(ctx, tx)
	if err != nil {
		return err
	}
	if l.StartedAt == nil || l.Deadline == nil {
		return nil
	}
	reason := "DEADLINE"
	if l.Status == "SUBMITTED" || l.Status == "EVALUATED" {
		if !recover {
			return nil
		}
		reason = "RECOVERED"
		if err = recoverEvaluationStatus(ctx, tx, a, &l); err != nil {
			return err
		}
	} else if l.Status != "IN_PROGRESS" || now.Before(*l.Deadline) {
		return nil
	}
	state, err := readCheckpoint(ctx, tx, a, l)
	if err != nil {
		return err
	}
	if _, err = finalizeAttempt(ctx, tx, a, l, state, reason, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Server) sweepSubmissions(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT 'session',cs.id::text FROM candidate_sessions cs WHERE cs.started_at IS NOT NULL
 AND ((cs.status='IN_PROGRESS' AND cs.timer_expires_at<=clock_timestamp()) OR cs.status IN ('SUBMITTED','EVALUATED'))
 AND NOT EXISTS(SELECT 1 FROM attempt_submissions sub WHERE sub.session_id=cs.id)
 UNION ALL SELECT 'legacy',i.id::text FROM assessment_invitations i JOIN candidate_assessment_instances ai ON ai.blueprint_id=i.blueprint_id AND ai.student_id=i.student_id
 WHERE (ai.started_at IS NOT NULL OR ai.status IN ('SUBMITTED','EVALUATED')) AND ((ai.status='IN_PROGRESS' AND ai.timer_expires_at<=clock_timestamp()) OR ai.status IN ('SUBMITTED','EVALUATED'))
 AND NOT EXISTS(SELECT 1 FROM attempt_submissions sub WHERE sub.invitation_id=i.id)`)
	if err != nil {
		return err
	}
	type target struct{ kind, id string }
	targets := []target{}
	for rows.Next() {
		var item target
		if err = rows.Scan(&item.kind, &item.id); err != nil {
			rows.Close()
			return err
		}
		targets = append(targets, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range targets {
		a, loadErr := s.attempts.repository.FindAttempt(ctx, item.kind, item.id)
		if loadErr == nil {
			attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			loadErr = s.finalizeOne(attemptCtx, a, true)
			cancel()
		}
		if loadErr != nil {
			log.Printf("Unable to finalize attempt %s: %v", item.id, loadErr)
		}
	}
	return nil
}
func retryDeliveryDelay(attempts int) time.Duration {
	if attempts > 6 {
		attempts = 6
	}
	if attempts < 1 {
		attempts = 1
	}
	return time.Duration(1<<uint(attempts-1)) * time.Second
}
func (s *Server) dispatchSubmission(ctx context.Context) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var id string
	var payload json.RawMessage
	var attempts int
	err = tx.QueryRow(ctx, `SELECT submission_id::text,payload,attempts FROM submission_outbox WHERE delivered_at IS NULL AND next_attempt_at<=clock_timestamp()
 ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&id, &payload, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	publishCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	publishErr := s.messages.Publish(publishCtx, "assessment_submissions", id, payload)
	cancel()
	if publishErr != nil {
		_, err = tx.Exec(ctx, `UPDATE submission_outbox SET attempts=attempts+1,next_attempt_at=clock_timestamp()+$2::interval,last_error=$3 WHERE submission_id=$1`, id, retryDeliveryDelay(attempts+1).String(), "Broker delivery not confirmed; will retry")
	} else {
		_, err = tx.Exec(ctx, `UPDATE submission_outbox SET attempts=attempts+1,delivered_at=clock_timestamp(),last_error=NULL WHERE submission_id=$1`, id)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	return true, err
}
func (s *Server) runSubmissionJobs(ctx context.Context) {
	go func() {
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for {
			if err := s.sweepSubmissions(ctx); err != nil && ctx.Err() == nil {
				log.Printf("Submission sweep unavailable: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
		}
	}()
	go func() {
		for {
			jobCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			worked, err := s.dispatchSubmission(jobCtx)
			cancel()
			if err != nil && ctx.Err() == nil {
				log.Printf("Submission dispatcher unavailable: %v", err)
			}
			if worked && err == nil {
				continue
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
	}()
}
