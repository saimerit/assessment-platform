package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type attemptDB interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

type lifecycleRecord struct {
	InstanceID, Status  string
	Start, End          time.Time
	StartedAt, Deadline *time.Time
	Duration            int
}

type attemptFailure struct {
	status  int
	message string
}

func (e *attemptFailure) Error() string             { return e.message }
func attemptError(status int, message string) error { return &attemptFailure{status, message} }
func respondAttemptError(c *gin.Context, err error) {
	var failure *attemptFailure
	if errors.As(err, &failure) {
		c.JSON(failure.status, gin.H{"error": failure.message})
		return
	}
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Unable to access assessment state. Please retry."})
}

func loadLifecycle(ctx context.Context, db attemptDB, a attemptRecord, lock bool) (lifecycleRecord, error) {
	var state lifecycleRecord
	var query string
	if a.Kind == attemptSession {
		query = `SELECT cs.id::text,cs.status,e.scheduled_start,e.scheduled_end,cs.started_at,cs.timer_expires_at,e.duration_minutes
          FROM candidate_sessions cs JOIN assessment_events e ON e.id=cs.assessment_id WHERE cs.id=$1`
		if lock {
			query += ` FOR UPDATE OF cs`
		}
	} else {
		query = `SELECT COALESCE(ai.id::text,''),CASE WHEN i.status='INVITED' THEN COALESCE(ai.status,'INVITED') ELSE i.status END,
          i.scheduled_start,i.scheduled_end,
 COALESCE(ai.started_at,CASE WHEN ai.status IN ('SUBMITTED','EVALUATED') THEN ai.created_at END),
 COALESCE(ai.timer_expires_at,CASE WHEN ai.status IN ('SUBMITTED','EVALUATED') THEN ai.created_at+b.duration_minutes*interval '1 minute' END),b.duration_minutes
          FROM assessment_invitations i JOIN assessment_blueprints b ON b.id=i.blueprint_id
          LEFT JOIN candidate_assessment_instances ai ON ai.blueprint_id=i.blueprint_id AND ai.student_id=i.student_id WHERE i.id=$1`
		if lock {
			query += ` FOR UPDATE OF i`
		}
	}
	err := db.QueryRow(ctx, query, a.ID).Scan(&state.InstanceID, &state.Status, &state.Start, &state.End, &state.StartedAt, &state.Deadline, &state.Duration)
	if state.StartedAt != nil {
		utc := state.StartedAt.UTC()
		state.StartedAt = &utc
	}
	if state.Deadline != nil {
		utc := state.Deadline.UTC()
		state.Deadline = &utc
	}
	if state.StartedAt != nil && state.Deadline != nil {
		state.Duration = int(state.Deadline.Sub(*state.StartedAt) / time.Minute)
	}
	return state, err
}

func (state lifecycleRecord) validate(now time.Time, requireStarted bool) error {
	if state.Status != "INVITED" && state.Status != "IN_PROGRESS" {
		return attemptError(409, "Assessment attempt is no longer active")
	}
	if state.StartedAt != nil {
		if state.Deadline == nil || !now.Before(*state.Deadline) {
			return attemptError(403, "Exam timer has expired")
		}
		return nil
	}
	if requireStarted {
		return attemptError(403, "Assessment timer has not started")
	}
	if now.Before(state.Start) {
		return attemptError(403, "Assessment window has not opened yet")
	}
	if !now.Before(state.End) {
		return attemptError(403, "Assessment time window has expired")
	}
	return nil
}

func (s *Server) startAttempt(c *gin.Context) {
	ctx := c.Request.Context()
	a := currentAttempt(c)
	if a.UnlockedAt == nil {
		respondAttemptError(c, attemptError(403, "Assessment must be unlocked before it can start"))
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	state, err := loadLifecycle(ctx, tx, a, true)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	now, err := attemptNow(ctx, tx)
	if err == nil {
		err = state.validate(now, false)
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	firstStart := state.StartedAt == nil
	if firstStart && a.Kind == attemptLegacy && state.InstanceID == "" {
		ids, generateErr := generatePaper(ctx, tx, a.AssessmentID, a.StudentID)
		err = generateErr
		if err == nil && len(ids) == 0 {
			err = attemptError(409, "No questions are available for this assessment")
		}
		if err == nil {
			err = tx.QueryRow(ctx, `INSERT INTO candidate_assessment_instances(blueprint_id,student_id,status) VALUES($1,$2,'IN_PROGRESS') RETURNING id::text`, a.AssessmentID, a.StudentID).Scan(&state.InstanceID)
		}
		for index, id := range ids {
			if err != nil {
				break
			}
			_, err = tx.Exec(ctx, `INSERT INTO instance_questions(instance_id,question_id,display_order) VALUES($1,$2,$3)`, state.InstanceID, id, index+1)
		}
	}
	source := "RECOVERED_CURRENT"
	if firstStart {
		source = "PINNED_START"
	}
	if err == nil {
		_, err = pinAttemptPaper(ctx, tx, a, source)
	}
	// Start the duration only after the complete paper/key snapshot is ready.
	// Recheck the entry window after any authoring lock wait.
	if err == nil {
		now, err = attemptNow(ctx, tx)
	}
	if err == nil {
		err = state.validate(now, false)
	}
	if err == nil && firstStart {
		deadline := now.Add(time.Duration(state.Duration) * time.Minute)
		if a.Kind == attemptSession {
			_, err = tx.Exec(ctx, `UPDATE candidate_sessions SET started_at=$2,timer_expires_at=$3 WHERE id=$1`, a.ID, now, deadline)
		} else {
			_, err = tx.Exec(ctx, `UPDATE candidate_assessment_instances SET started_at=$2,timer_expires_at=$3,status='IN_PROGRESS' WHERE id=$1`, state.InstanceID, now, deadline)
		}
		state.StartedAt, state.Deadline = &now, &deadline
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	payload := gin.H{"started_at": state.StartedAt, "timer_expires_at": state.Deadline, "duration_minutes": state.Duration, "server_time": now, "status": "IN_PROGRESS"}
	if a.Kind == attemptLegacy {
		questions, fetchErr := readAttemptPaper(ctx, s.db, a)
		if fetchErr != nil {
			respondAttemptError(c, fetchErr)
			return
		}
		payload["instance_id"], payload["questions"] = state.InstanceID, questions
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, payload)
}
