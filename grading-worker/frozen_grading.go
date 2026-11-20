package main

import (
	"assessment/workerqueue"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
)

type frozenQuestion struct {
	ID    string  `json:"question_id"`
	Type  string  `json:"question_type"`
	Marks float64 `json:"marks"`
}
type frozenAnswer struct {
	ID      string   `json:"question_id"`
	Options []string `json:"selected_option_ids"`
	Text    *string  `json:"typed_response"`
}
type frozenKey struct {
	Type          string
	Options       []string
	Text          *string
	CaseSensitive bool
}

func scoreFrozenAnswer(q frozenQuestion, a frozenAnswer, key frozenKey) float64 {
	if q.Type != key.Type {
		return 0
	}
	if q.Type == "MCQ" {
		if len(a.Options) == 0 || len(key.Options) == 0 {
			return 0
		}
		allowed := map[string]bool{}
		for _, id := range key.Options {
			allowed[id] = true
		}
		selected := map[string]bool{}
		for _, id := range a.Options {
			if !allowed[id] || selected[id] {
				return 0
			}
			selected[id] = true
		}
		return q.Marks * float64(len(selected)) / float64(len(allowed))
	}
	if q.Type == "FIB" && a.Text != nil && key.Text != nil {
		actual, expected := strings.TrimSpace(*a.Text), strings.TrimSpace(*key.Text)
		if actual != "" && ((key.CaseSensitive && actual == expected) || (!key.CaseSensitive && strings.EqualFold(actual, expected))) {
			return q.Marks
		}
	}
	return 0
}
func evaluateFrozenSubmission(ctx context.Context, db *pgxpool.Pool, event AssessmentSubmittedEvent) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var version int
	var status, snapshot, student, assessment string
	var session, instance *string
	var encodedAnswers, encodedQuestions json.RawMessage
	err = tx.QueryRow(ctx, `SELECT version,grading_status,snapshot_id::text,student_id::text,assessment_id::text,session_id::text,instance_id::text,answers FROM attempt_submissions WHERE id=$1 FOR UPDATE`, event.SubmissionID).
		Scan(&version, &status, &snapshot, &student, &assessment, &session, &instance, &encodedAnswers)
	if err != nil {
		return err
	}
	if event.Version != version || (event.StudentID != "" && event.StudentID != student) || (event.BlueprintID != "" && event.BlueprintID != assessment) ||
		(event.SessionID != "" && (session == nil || event.SessionID != *session)) || (event.InstanceID != "" && (instance == nil || event.InstanceID != *instance)) {
		return errors.New("Submission identity/version mismatch")
	}
	if status == "GRADED" {
		if err := workerqueue.CompleteInTransaction(ctx, tx); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	var policy string
	if err = tx.QueryRow(ctx, `SELECT questions,grading_policy FROM attempt_paper_snapshots WHERE id=$1`, snapshot).Scan(&encodedQuestions, &policy); err != nil {
		return err
	}
	if policy != "objective-v1" {
		return fmt.Errorf("Unsupported grading policy %q", policy)
	}
	var questions []frozenQuestion
	var answers []frozenAnswer
	if err = json.Unmarshal(encodedQuestions, &questions); err != nil {
		return err
	}
	if err = json.Unmarshal(encodedAnswers, &answers); err != nil {
		return err
	}
	responses := map[string]frozenAnswer{}
	for _, answer := range answers {
		responses[answer.ID] = answer
	}
	keys := map[string]frozenKey{}
	rows, err := tx.Query(ctx, `SELECT question_id::text,q_type,array_remove(COALESCE(expected_option_ids,'{}'::uuid[]),NULL)::text[],expected_text,case_sensitive FROM answer_vault.attempt_snapshot_keys WHERE snapshot_id=$1`, snapshot)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var key frozenKey
		if err = rows.Scan(&id, &key.Type, &key.Options, &key.Text, &key.CaseSensitive); err != nil {
			rows.Close()
			return err
		}
		keys[id] = key
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	total, max := 0.0, 0.0
	for _, q := range questions {
		key, ok := keys[q.ID]
		if !ok {
			return errors.New("Pinned grading key is missing")
		}
		max += q.Marks
		total += scoreFrozenAnswer(q, responses[q.ID], key)
	}
	if session != nil {
		_, err = tx.Exec(ctx, `INSERT INTO candidate_session_results(session_id,score_obtained,max_score) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET score_obtained=EXCLUDED.score_obtained,max_score=EXCLUDED.max_score,evaluated_at=clock_timestamp()`, session, total, max)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE candidate_sessions SET status='EVALUATED' WHERE id=$1`, session)
		}
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO candidate_results(instance_id,total_score,max_score) VALUES($1,$2,$3) ON CONFLICT(instance_id) DO UPDATE SET total_score=EXCLUDED.total_score,max_score=EXCLUDED.max_score,evaluated_at=clock_timestamp()`, instance, total, max)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE candidate_assessment_instances SET status='EVALUATED' WHERE id=$1`, instance)
		}
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE attempt_submissions SET grading_status='GRADED',graded_at=clock_timestamp() WHERE id=$1`, event.SubmissionID)
	}
	if err != nil {
		return err
	}
	if err = workerqueue.CompleteInTransaction(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
