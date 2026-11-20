package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

var checkpointUUID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

type checkpointAnswer struct {
	QuestionID        string   `json:"question_id"`
	SelectedOptionIDs []string `json:"selected_option_ids"`
	TypedResponse     *string  `json:"typed_response"`
	Reviewed          bool     `json:"reviewed"`
}
type checkpointNavigation struct {
	QuestionID *string `json:"question_id"`
	ActiveView string  `json:"active_view"`
}
type checkpointUpdate struct {
	UpdateID     string                `json:"update_id"`
	BaseRevision int64                 `json:"base_revision"`
	Answers      []checkpointAnswer    `json:"answers"`
	Navigation   *checkpointNavigation `json:"navigation,omitempty"`
}
type checkpointState struct {
	ID         string               `json:"-"`
	Revision   int64                `json:"revision"`
	Answers    []checkpointAnswer   `json:"answers"`
	Navigation checkpointNavigation `json:"navigation"`
	SavedAt    *time.Time           `json:"saved_at"`
	StartedAt  *time.Time           `json:"started_at"`
	Deadline   *time.Time           `json:"timer_expires_at"`
	ServerTime time.Time            `json:"server_time"`
}
type answerStorage struct{ table, key, owner, checkpointColumn, paperFilter string }

func storageFor(a attemptRecord, l lifecycleRecord) answerStorage {
	if a.Kind == attemptSession {
		return answerStorage{"candidate_session_answers", "session_id", a.ID, "session_id", "s.session_id=$1"}
	}
	return answerStorage{"candidate_answers", "instance_id", l.InstanceID, "invitation_id", `s.invitation_id=(SELECT i.id FROM assessment_invitations i JOIN candidate_assessment_instances ai ON ai.blueprint_id=i.blueprint_id AND ai.student_id=i.student_id WHERE ai.id=$1)`}
}
func (storage answerStorage) membership() string {
	return `SELECT q->>'question_type' FROM attempt_paper_snapshots s CROSS JOIN jsonb_array_elements(s.questions) q WHERE ` + storage.paperFilter + ` AND q->>'question_id'=$2`
}

func normalizeCheckpointAnswer(answer *checkpointAnswer, qtype string) error {
	if !checkpointUUID.MatchString(answer.QuestionID) {
		return attemptError(400, "Invalid question identifier")
	}
	if answer.SelectedOptionIDs == nil {
		answer.SelectedOptionIDs = []string{}
	}
	sort.Strings(answer.SelectedOptionIDs)
	for index, id := range answer.SelectedOptionIDs {
		if !checkpointUUID.MatchString(id) || (index > 0 && id == answer.SelectedOptionIDs[index-1]) {
			return attemptError(400, "Selected options must be valid and unique")
		}
	}
	if qtype == "MCQ" {
		if answer.TypedResponse != nil {
			return attemptError(400, "Multiple-choice responses accept selected options only")
		}
	} else if qtype == "FIB" {
		if len(answer.SelectedOptionIDs) > 0 {
			return attemptError(400, "Fill-in-the-blank responses accept text only")
		}
		if answer.TypedResponse == nil {
			empty := ""
			answer.TypedResponse = &empty
		}
		if len(*answer.TypedResponse) > 16384 {
			return attemptError(400, "Typed response is too long")
		}
	} else {
		return attemptError(400, "Unsupported question type")
	}
	return nil
}

func validateCheckpointUpdate(ctx context.Context, db attemptDB, storage answerStorage, update *checkpointUpdate) error {
	if !checkpointUUID.MatchString(update.UpdateID) || update.BaseRevision < 0 || len(update.Answers) > 100 {
		return attemptError(400, "Invalid checkpoint update")
	}
	seen := map[string]bool{}
	for index := range update.Answers {
		answer := &update.Answers[index]
		if seen[answer.QuestionID] {
			return attemptError(400, "A question may appear only once per save")
		}
		seen[answer.QuestionID] = true
		if !checkpointUUID.MatchString(answer.QuestionID) {
			return attemptError(400, "Invalid question identifier")
		}
		var qtype string
		if err := db.QueryRow(ctx, storage.membership(), storage.owner, answer.QuestionID).Scan(&qtype); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return attemptError(400, "Answer includes a question outside this paper")
			}
			return err
		}
		if err := normalizeCheckpointAnswer(answer, qtype); err != nil {
			return err
		}
		for _, id := range answer.SelectedOptionIDs {
			var valid bool
			if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM attempt_paper_snapshots s CROSS JOIN jsonb_array_elements(s.questions) q CROSS JOIN jsonb_array_elements(q->'options') o WHERE `+storage.paperFilter+` AND q->>'question_id'=$2 AND o->>'id'=$3)`, storage.owner, answer.QuestionID, id).Scan(&valid); err != nil {
				return err
			}
			if !valid {
				return attemptError(400, "Selected option does not belong to question")
			}
		}
	}
	if update.Navigation != nil {
		nav := update.Navigation
		if nav.ActiveView != "home" && nav.ActiveView != "question" {
			return attemptError(400, "Invalid navigation state")
		}
		if nav.QuestionID != nil {
			if !checkpointUUID.MatchString(*nav.QuestionID) {
				return attemptError(400, "Invalid navigation question")
			}
			var qtype string
			if err := db.QueryRow(ctx, storage.membership(), storage.owner, *nav.QuestionID).Scan(&qtype); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return attemptError(400, "Navigation question is outside this paper")
				}
				return err
			}
		} else if nav.ActiveView == "question" {
			return attemptError(400, "Choose a question for question navigation")
		}
	}
	return nil
}

func readCheckpoint(ctx context.Context, tx pgx.Tx, a attemptRecord, l lifecycleRecord) (checkpointState, error) {
	storage := storageFor(a, l)
	var result checkpointState
	_, err := tx.Exec(ctx, fmt.Sprintf(`INSERT INTO attempt_checkpoints(%s) VALUES($1) ON CONFLICT(%s) DO NOTHING`, storage.checkpointColumn, storage.checkpointColumn), a.ID)
	if err != nil {
		return result, err
	}
	err = tx.QueryRow(ctx, fmt.Sprintf(`SELECT id::text,revision,last_question_id::text,active_view,saved_at FROM attempt_checkpoints WHERE %s=$1`, storage.checkpointColumn), a.ID).
		Scan(&result.ID, &result.Revision, &result.Navigation.QuestionID, &result.Navigation.ActiveView, &result.SavedAt)
	if err != nil {
		return result, err
	}
	rows, err := tx.Query(ctx, fmt.Sprintf(`SELECT question_id::text,COALESCE(selected_option_ids,'{}'::uuid[])::text[],typed_response,flagged_for_review FROM %s WHERE %s=$1 ORDER BY question_id`, storage.table, storage.key), storage.owner)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	result.Answers = []checkpointAnswer{}
	for rows.Next() {
		var answer checkpointAnswer
		if err = rows.Scan(&answer.QuestionID, &answer.SelectedOptionIDs, &answer.TypedResponse, &answer.Reviewed); err != nil {
			return result, err
		}
		result.Answers = append(result.Answers, answer)
	}
	result.StartedAt, result.Deadline, result.ServerTime = l.StartedAt, l.Deadline, time.Now().UTC()
	return result, rows.Err()
}

func writeCheckpointAnswers(ctx context.Context, tx pgx.Tx, storage answerStorage, answers []checkpointAnswer) error {
	for _, answer := range answers {
		_, err := tx.Exec(ctx, fmt.Sprintf(`INSERT INTO %s(%s,question_id,selected_option_id,selected_option_ids,typed_response,flagged_for_review)
          VALUES($1,$2,(SELECT id FROM mcq_options WHERE id=NULLIF($3,'')::uuid),NULLIF(ARRAY(SELECT unnest($4::text[])::uuid),'{}'::uuid[]),$5,$6)
          ON CONFLICT(%s,question_id) DO UPDATE SET selected_option_id=EXCLUDED.selected_option_id,selected_option_ids=EXCLUDED.selected_option_ids,
          typed_response=EXCLUDED.typed_response,flagged_for_review=EXCLUDED.flagged_for_review,answered_at=NOW()`, storage.table, storage.key, storage.key),
			storage.owner, answer.QuestionID, firstOptionID(answer.SelectedOptionIDs), answer.SelectedOptionIDs, answer.TypedResponse, answer.Reviewed)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) GetAttemptCheckpoint(c *gin.Context) {
	s.handleCheckpoint(c, false)
}
func (s *Server) SaveAttemptCheckpoint(c *gin.Context) {
	s.handleCheckpoint(c, true)
}
func (s *Server) handleCheckpoint(c *gin.Context, save bool) {
	ctx := c.Request.Context()
	a := currentAttempt(c)
	var update checkpointUpdate
	if save && c.ShouldBindJSON(&update) != nil {
		respondAttemptError(c, attemptError(400, "Invalid checkpoint request"))
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	defer tx.Rollback(ctx)
	l, err := loadLifecycle(ctx, tx, a, true)
	if err == nil {
		now, clockErr := attemptNow(ctx, tx)
		if clockErr != nil {
			err = clockErr
		} else {
			err = l.validate(now, true)
		}
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	state, err := readCheckpoint(ctx, tx, a, l)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	if save {
		err = validateCheckpointUpdate(ctx, tx, storageFor(a, l), &update)
		if err != nil {
			respondAttemptError(c, err)
			return
		}
		encoded, _ := json.Marshal(update)
		digest := sha256.Sum256(encoded)
		fingerprint := hex.EncodeToString(digest[:])
		var previous string
		receiptErr := tx.QueryRow(ctx, `SELECT fingerprint FROM attempt_checkpoint_updates WHERE checkpoint_id=$1 AND update_id=$2`, state.ID, update.UpdateID).Scan(&previous)
		if receiptErr == nil {
			if previous != fingerprint {
				c.JSON(409, gin.H{"error": "Save identifier was reused with different data", "checkpoint": state})
				return
			}
		} else {
			if !errors.Is(receiptErr, pgx.ErrNoRows) {
				respondAttemptError(c, receiptErr)
				return
			}
			if update.BaseRevision != state.Revision {
				c.JSON(409, gin.H{"error": "Another save advanced this attempt. Review the current saved state.", "checkpoint": state})
				return
			}
			if err = writeCheckpointAnswers(ctx, tx, storageFor(a, l), update.Answers); err != nil {
				respondAttemptError(c, err)
				return
			}
			if update.Navigation != nil {
				_, err = tx.Exec(ctx, `UPDATE attempt_checkpoints SET last_question_id=$2,active_view=$3 WHERE id=$1`, state.ID, update.Navigation.QuestionID, update.Navigation.ActiveView)
			}
			if err == nil {
				_, err = tx.Exec(ctx, `UPDATE attempt_checkpoints SET revision=revision+1,saved_at=clock_timestamp() WHERE id=$1`, state.ID)
			}
			if err == nil {
				_, err = tx.Exec(ctx, `INSERT INTO attempt_checkpoint_updates(checkpoint_id,update_id,fingerprint,revision) VALUES($1,$2,$3,$4)`, state.ID, update.UpdateID, fingerprint, state.Revision+1)
			}
			if err != nil {
				respondAttemptError(c, err)
				return
			}
			state, err = readCheckpoint(ctx, tx, a, l)
		}
	}
	if err == nil && save {
		now, clockErr := attemptNow(ctx, tx)
		if clockErr != nil {
			err = clockErr
		} else {
			err = l.validate(now, true)
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, state)
}

func nonemptyAnswer(answer checkpointAnswer) bool {
	return len(answer.SelectedOptionIDs) > 0 || (answer.TypedResponse != nil && strings.TrimSpace(*answer.TypedResponse) != "")
}
