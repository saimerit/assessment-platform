package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"time"
)

type submissionAnswer struct {
	QuestionID        string   `json:"question_id"`
	OptionID          string   `json:"option_id"`
	OptionIDs         []string `json:"option_ids"`
	SelectedOptionID  string   `json:"selected_option_id"`
	SelectedOptionIDs []string `json:"selected_option_ids"`
	TypedResponse     *string  `json:"typed_response"`
}

func newCheckpointUpdateID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}

type submissionReceipt struct {
	SubmissionID   string    `json:"submission_id"`
	Version        int       `json:"version"`
	SessionID      *string   `json:"session_id,omitempty"`
	InstanceID     *string   `json:"instance_id,omitempty"`
	Revision       int64     `json:"checkpoint_revision"`
	SubmittedAt    time.Time `json:"submitted_at"`
	FinalizedAt    time.Time `json:"finalized_at"`
	Deadline       time.Time `json:"timer_expires_at"`
	Reason         string    `json:"reason"`
	Answered       int       `json:"answered_count"`
	Questions      int       `json:"question_count"`
	GradingStatus  string    `json:"-"`
	DeliveryStatus string    `json:"-"`
}

func readSubmissionReceipt(ctx context.Context, db attemptDB, a attemptRecord) (submissionReceipt, error) {
	var r submissionReceipt
	err := db.QueryRow(ctx, `SELECT sub.id::text,sub.version,sub.session_id::text,sub.instance_id::text,sub.checkpoint_revision,sub.submitted_at,sub.finalized_at,sub.deadline,sub.reason,sub.answered_count,sub.question_count,sub.grading_status,
 CASE WHEN sub.grading_status='GRADED' THEN 'GRADED' WHEN outbox.delivered_at IS NOT NULL THEN 'QUEUED' ELSE 'PENDING' END
 FROM attempt_submissions sub LEFT JOIN submission_outbox outbox ON outbox.submission_id=sub.id
 WHERE (sub.session_id=$1::uuid AND $2='session') OR (sub.invitation_id=$1::uuid AND $2='legacy')`, a.ID, a.Kind).Scan(&r.SubmissionID, &r.Version, &r.SessionID, &r.InstanceID, &r.Revision, &r.SubmittedAt, &r.FinalizedAt, &r.Deadline, &r.Reason, &r.Answered, &r.Questions, &r.GradingStatus, &r.DeliveryStatus)
	r.SubmittedAt = r.SubmittedAt.UTC()
	r.FinalizedAt = r.FinalizedAt.UTC()
	r.Deadline = r.Deadline.UTC()
	return r, err
}

func recoverEvaluationStatus(ctx context.Context, db attemptDB, a attemptRecord, l *lifecycleRecord) error {
	if l.Status != "SUBMITTED" {
		return nil
	}
	query := `SELECT EXISTS(SELECT 1 FROM candidate_session_results WHERE session_id=$1)`
	owner := a.ID
	if a.Kind == attemptLegacy {
		query = `SELECT EXISTS(SELECT 1 FROM candidate_results WHERE instance_id=$1)`
		owner = l.InstanceID
	}
	var graded bool
	err := db.QueryRow(ctx, query, owner).Scan(&graded)
	if err == nil && graded {
		l.Status = "EVALUATED"
	}
	return err
}

// Parent locking gives finalization, answer saves and deadline sweeps one order.
// The immutable answer snapshot and its grading job commit with the receipt.
func finalizeAttempt(ctx context.Context, tx pgx.Tx, a attemptRecord, l lifecycleRecord, state checkpointState, reason string, now time.Time) (submissionReceipt, error) {
	var empty submissionReceipt
	if l.StartedAt == nil || l.Deadline == nil {
		return empty, attemptError(403, "Assessment timer has not started")
	}
	snapshot, err := pinAttemptPaper(ctx, tx, a, "RECOVERED_CURRENT")
	if err != nil {
		return empty, err
	}
	var questionCount int
	if err = tx.QueryRow(ctx, `SELECT jsonb_array_length(questions) FROM attempt_paper_snapshots WHERE id=$1`, snapshot).Scan(&questionCount); err != nil {
		return empty, err
	}
	answered := 0
	for _, answer := range state.Answers {
		if nonemptyAnswer(answer) {
			answered++
		}
	}
	encoded, err := json.Marshal(state.Answers)
	if err != nil {
		return empty, err
	}
	now, err = attemptNow(ctx, tx)
	if err != nil {
		return empty, err
	}
	if reason == "MANUAL" && !now.Before(*l.Deadline) {
		reason = "DEADLINE"
	}
	submittedAt := now
	if reason == "DEADLINE" {
		submittedAt = *l.Deadline
	}
	var session, invitation, instance *string
	if a.Kind == attemptSession {
		session = &a.ID
	} else {
		invitation = &a.ID
		instance = &l.InstanceID
	}
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO attempt_submissions(session_id,invitation_id,instance_id,snapshot_id,org_id,student_id,assessment_id,checkpoint_revision,answers,question_count,answered_count,deadline,submitted_at,reason,grading_status)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id::text`, session, invitation, instance, snapshot, a.OrgID, a.StudentID, a.AssessmentID, state.Revision, encoded, questionCount, answered, l.Deadline, submittedAt, reason, func() string {
		if l.Status == "EVALUATED" {
			return "GRADED"
		}
		return "PENDING"
	}()).Scan(&id)
	if err != nil {
		return empty, err
	}
	event := AssessmentSubmittedEvent{SubmissionID: id, Version: 1, StudentID: a.StudentID, BlueprintID: a.AssessmentID, SubmittedAt: submittedAt}
	if a.Kind == attemptSession {
		event.SessionID = a.ID
	} else {
		event.InstanceID = l.InstanceID
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return empty, err
	}
	if l.Status != "EVALUATED" {
		if _, err = tx.Exec(ctx, `INSERT INTO submission_outbox(submission_id,payload) VALUES($1,$2)`, id, payload); err != nil {
			return empty, err
		}
	}
	if a.Kind == attemptSession {
		_, err = tx.Exec(ctx, `UPDATE candidate_sessions SET status=CASE WHEN status='EVALUATED' THEN status ELSE 'SUBMITTED' END WHERE id=$1`, a.ID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE candidate_assessment_instances SET status=CASE WHEN status='EVALUATED' THEN status ELSE 'SUBMITTED' END WHERE id=$1`, l.InstanceID)
	}
	if err != nil {
		return empty, err
	}
	return readSubmissionReceipt(ctx, tx, a)
}

func (s *Server) submitAttempt(c *gin.Context) {
	ctx := c.Request.Context()
	a := currentAttempt(c)
	var req struct {
		StudentID string             `json:"student_id"`
		Revision  *int64             `json:"checkpoint_revision"`
		Answers   []submissionAnswer `json:"answers"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondAttemptError(c, attemptError(400, "Invalid submission request"))
		return
	}
	if !allowAttemptCandidate(c, req.StudentID) {
		return
	}
	if req.Revision != nil && (*req.Revision < 0 || len(req.Answers) > 0) {
		respondAttemptError(c, attemptError(400, "Versioned submission uses the saved snapshot only"))
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	l, err := loadLifecycle(ctx, tx, a, true)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	receipt, err := readSubmissionReceipt(ctx, tx, a)
	if err == nil {
		if err = tx.Commit(ctx); err != nil {
			respondAttemptError(c, err)
			return
		}
		c.JSON(200, receipt)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		respondAttemptError(c, err)
		return
	}
	now, err := attemptNow(ctx, tx)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	if l.StartedAt == nil || l.Deadline == nil {
		respondAttemptError(c, attemptError(403, "Assessment timer has not started"))
		return
	}
	recovered := l.Status == "SUBMITTED" || l.Status == "EVALUATED"
	if recovered {
		if err = recoverEvaluationStatus(ctx, tx, a, &l); err != nil {
			respondAttemptError(c, err)
			return
		}
	}
	if !recovered && l.Status != "IN_PROGRESS" {
		respondAttemptError(c, attemptError(409, "Assessment attempt is no longer active"))
		return
	}
	expired := !now.Before(*l.Deadline)
	if expired && len(req.Answers) > 0 {
		respondAttemptError(c, attemptError(403, "Exam timer has expired; only saved responses can be finalized"))
		return
	}
	state, err := readCheckpoint(ctx, tx, a, l)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	if !expired && !recovered && req.Revision != nil && *req.Revision != state.Revision {
		c.JSON(409, gin.H{"error": "Answers changed. Synchronize before submitting.", "checkpoint": state})
		return
	}
	if !expired && !recovered && len(req.Answers) > 0 {
		flags := map[string]bool{}
		for _, answer := range state.Answers {
			flags[answer.QuestionID] = answer.Reviewed
		}
		update := checkpointUpdate{UpdateID: newCheckpointUpdateID(), BaseRevision: state.Revision}
		for _, answer := range req.Answers {
			ids := answer.SelectedOptionIDs
			if len(ids) == 0 {
				ids = answer.OptionIDs
			}
			if len(ids) == 0 && answer.SelectedOptionID != "" {
				ids = []string{answer.SelectedOptionID}
			}
			if len(ids) == 0 && answer.OptionID != "" {
				ids = []string{answer.OptionID}
			}
			update.Answers = append(update.Answers, checkpointAnswer{answer.QuestionID, ids, answer.TypedResponse, flags[answer.QuestionID]})
		}
		if err = validateCheckpointUpdate(ctx, tx, storageFor(a, l), &update); err == nil {
			err = writeCheckpointAnswers(ctx, tx, storageFor(a, l), update.Answers)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE attempt_checkpoints SET revision=revision+1,saved_at=clock_timestamp() WHERE id=$1`, state.ID)
		}
		if err == nil {
			now, err = attemptNow(ctx, tx)
		}
		if err == nil && !now.Before(*l.Deadline) {
			err = attemptError(403, "Exam timer expired before responses could be accepted")
		}
		if err == nil {
			state, err = readCheckpoint(ctx, tx, a, l)
		}
		if err != nil {
			respondAttemptError(c, err)
			return
		}
	}
	reason := "MANUAL"
	if expired {
		reason = "DEADLINE"
	}
	if recovered {
		reason = "RECOVERED"
	}
	receipt, err = finalizeAttempt(ctx, tx, a, l, state, reason, now)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	c.JSON(202, receipt)
}

func (s *Server) GetSubmissionReceipt(c *gin.Context) {
	ctx := c.Request.Context()
	a := currentAttempt(c)
	receipt, err := readSubmissionReceipt(ctx, s.db, a)
	if errors.Is(err, pgx.ErrNoRows) {
		if sweepErr := s.finalizeOne(ctx, a, a.isFinalized()); sweepErr != nil {
			respondAttemptError(c, sweepErr)
			return
		}
		receipt, err = readSubmissionReceipt(ctx, s.db, a)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(404, gin.H{"error": "No submission receipt is available yet", "code": "NO_RECEIPT"})
		return
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	c.JSON(200, receipt)
}
