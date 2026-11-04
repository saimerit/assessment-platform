package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	amqp "github.com/rabbitmq/amqp091-go"
)

type sessionRecord struct {
	ID, AssessmentID, PaperID, StudentID, ProctorID, Status, Mode, OrgID string
	Start, End                                                           time.Time
	StartedAt                                                            *time.Time
	DurationMinutes                                                      int
}

func (s *Server) FetchSessionQuestions(c *gin.Context) {
	ctx := c.Request.Context()
	var status string
	var startedAt *time.Time
	var durationMinutes int
	err := s.db.QueryRow(ctx, `SELECT cs.status,cs.started_at,e.duration_minutes FROM candidate_sessions cs JOIN assessment_events e ON e.id=cs.assessment_id WHERE cs.id=$1`, c.Param("session_id")).Scan(&status, &startedAt, &durationMinutes)
	if err != nil || status != "IN_PROGRESS" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment session is not unlocked"})
		return
	}
	if startedAt == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment timer has not started"})
		return
	}
	timerExpiresAt := startedAt.Add(time.Duration(durationMinutes) * time.Minute)
	if !time.Now().Before(timerExpiresAt) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Exam timer has expired"})
		return
	}
	rows, err := s.db.Query(ctx, `SELECT q.id::text,q.title,q.statement,q.q_type,q.marks,pq.sort_order,COALESCE(q.bank_id::text,''),COALESCE(b.name,'Assessment questions') FROM candidate_sessions cs JOIN paper_questions pq ON pq.paper_id=cs.paper_id JOIN questions q ON q.id=pq.question_id LEFT JOIN question_banks b ON b.id=q.bank_id WHERE cs.id=$1 ORDER BY pq.sort_order`, c.Param("session_id"))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load assessment paper"})
		return
	}
	defer rows.Close()
	questions := []gin.H{}
	for rows.Next() {
		var id, title, statement, qtype, sectionID, sectionName string
		var marks, order int
		if rows.Scan(&id, &title, &statement, &qtype, &marks, &order, &sectionID, &sectionName) != nil {
			c.JSON(500, gin.H{"error": "Unable to read assessment paper"})
			return
		}
		item := gin.H{"question_id": id, "title": title, "statement": statement, "question_type": qtype, "marks": marks, "display_order": order, "section_id": sectionID, "section_name": sectionName}
		if qtype == "MCQ" {
			opts, err := s.db.Query(ctx, `SELECT id::text,option_text FROM mcq_options WHERE question_id=$1 ORDER BY display_order,id`, id)
			if err != nil {
				c.JSON(500, gin.H{"error": "Unable to load question options"})
				return
			}
			options := []gin.H{}
			for opts.Next() {
				var oid, text string
				if opts.Scan(&oid, &text) == nil {
					options = append(options, gin.H{"id": oid, "text": text})
				}
			}
			opts.Close()
			item["options"] = options
		}
		questions = append(questions, item)
	}
	if rows.Err() != nil {
		c.JSON(500, gin.H{"error": "Unable to read assessment paper"})
		return
	}
	c.JSON(200, gin.H{"session_id": c.Param("session_id"), "started_at": startedAt, "timer_expires_at": timerExpiresAt, "duration_minutes": durationMinutes, "questions": questions})
}

// VerifyExamUnlock validates the reusable event/proctor code and unlocks one
// candidate session. Passcodes are deliberately read without consuming or
// deleting them so an assigned proctor can start every candidate session
// before the code's time-based Redis expiry.
func (s *Server) VerifyExamUnlock(c *gin.Context) {
	ctx := c.Request.Context()
	var req struct {
		Passcode        string `json:"passcode" binding:"required"`
		CameraReady     bool   `json:"camera_ready"`
		MicrophoneReady bool   `json:"microphone_ready"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "Passcode is required"})
		return
	}
	var v sessionRecord
	err := s.db.QueryRow(ctx, `SELECT cs.id::text,cs.assessment_id::text,cs.paper_id::text,cs.student_id::text,COALESCE(cs.assigned_proctor_id::text,''),cs.status,e.mode,e.scheduled_start,e.scheduled_end,COALESCE(e.org_id::text,''),cs.started_at,e.duration_minutes FROM candidate_sessions cs JOIN assessment_events e ON e.id=cs.assessment_id WHERE cs.id=$1`, c.Param("session_id")).Scan(&v.ID, &v.AssessmentID, &v.PaperID, &v.StudentID, &v.ProctorID, &v.Status, &v.Mode, &v.Start, &v.End, &v.OrgID, &v.StartedAt, &v.DurationMinutes)
	if err != nil {
		c.JSON(404, gin.H{"error": "Assessment session not found"})
		return
	}
	if v.Status != "INVITED" && v.Status != "IN_PROGRESS" {
		c.JSON(409, gin.H{"error": "Assessment session cannot be unlocked"})
		return
	}
	now := time.Now()
	if v.Status == "INVITED" || v.StartedAt == nil {
		if now.Before(v.Start) {
			c.JSON(403, gin.H{"error": "Assessment window has not opened yet"})
			return
		}
		if !now.Before(v.End) {
			c.JSON(403, gin.H{"error": "Assessment time window has expired"})
			return
		}
	} else if !now.Before(v.StartedAt.Add(time.Duration(v.DurationMinutes) * time.Minute)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Exam timer has expired"})
		return
	}
	if v.Mode == "ONLINE_PROCTORING" && (!req.CameraReady || !req.MicrophoneReady) {
		c.JSON(403, gin.H{"error": "Camera and microphone must be ready for online proctoring"})
		return
	}
	var authorized bool
	if v.Mode == "ONLINE_PROCTORING" || v.Mode == "OFFLINE_PROCTORING" {
		// Online and offline proctored sessions accept reusable codes issued to
		// any proctor assigned to the event. Unlocking does not consume a code.
		proctorRows, proctorErr := s.db.Query(ctx, `SELECT proctor_id::text FROM assessment_proctors WHERE assessment_id=$1`, v.AssessmentID)
		if proctorErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify event proctor assignment"})
			return
		}
		for proctorRows.Next() {
			var proctorID string
			if proctorRows.Scan(&proctorID) != nil {
				continue
			}
			assignedCode, codeErr := s.rdb.Get(ctx, fmt.Sprintf("event_proctor_passcode:%s:%s", v.AssessmentID, proctorID)).Result()
			if codeErr == nil && constantTimeCodeEqual(assignedCode, req.Passcode) {
				authorized = true
				break
			}
		}
		proctorRows.Close()
		if !authorized && proctorRows.Err() != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify event proctor assignment"})
			return
		}
		// The organization's admin may also proctor an event without being added
		// to its proctor assignments.
		if !authorized && v.OrgID != "" {
			var adminID string
			adminErr := s.db.QueryRow(ctx, `SELECT admin_id::text FROM organizations WHERE id=$1`, v.OrgID).Scan(&adminID)
			if adminErr == nil && adminID != "" {
				adminCode, codeErr := s.rdb.Get(ctx, adminProctoringCodeKey(v.OrgID, adminID)).Result()
				authorized = codeErr == nil && constantTimeCodeEqual(adminCode, req.Passcode)
			}
		}
	} else {
		eventCode, codeErr := s.rdb.Get(ctx, fmt.Sprintf("event_passcode:%s", v.AssessmentID)).Result()
		authorized = codeErr == nil && constantTimeCodeEqual(eventCode, req.Passcode)
	}
	if !authorized {
		c.JSON(403, gin.H{"error": "Invalid or expired proctor access code"})
		return
	}
	_, err = s.db.Exec(ctx, `UPDATE candidate_sessions SET status='IN_PROGRESS' WHERE id=$1 AND status IN ('INVITED','IN_PROGRESS')`, v.ID)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to unlock assessment"})
		return
	}
	c.JSON(200, gin.H{"status": "UNLOCKED", "session_id": v.ID, "assessment_id": v.AssessmentID, "proctoring_mode": v.Mode, "duration_minutes": v.DurationMinutes, "server_time": now.UTC(), "unlocked_at": now.Format(time.RFC3339)})
}

// BeginExamSession starts the candidate's duration timer after the candidate
// reviews the outline and explicitly enters the exam. The scheduled window is
// checked only when the timer has not started yet; a started attempt may finish
// within its duration even if the invitation window closes meanwhile.
func (s *Server) BeginExamSession(c *gin.Context) {
	ctx := c.Request.Context()
	var status string
	var scheduledStart, scheduledEnd time.Time
	var startedAt *time.Time
	var durationMinutes int
	err := s.db.QueryRow(ctx, `SELECT cs.status,e.scheduled_start,e.scheduled_end,cs.started_at,e.duration_minutes FROM candidate_sessions cs JOIN assessment_events e ON e.id=cs.assessment_id WHERE cs.id=$1`, c.Param("session_id")).Scan(&status, &scheduledStart, &scheduledEnd, &startedAt, &durationMinutes)
	if err != nil || status != "IN_PROGRESS" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment must be unlocked before it can start"})
		return
	}
	now := time.Now().UTC()
	if startedAt == nil {
		if now.Before(scheduledStart) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Assessment window has not opened yet"})
			return
		}
		if !now.Before(scheduledEnd) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Assessment time window has expired"})
			return
		}
		var started time.Time
		if err := s.db.QueryRow(ctx, `UPDATE candidate_sessions SET started_at=$2 WHERE id=$1 AND status='IN_PROGRESS' AND started_at IS NULL RETURNING started_at`, c.Param("session_id"), now).Scan(&started); err == nil {
			startedAt = &started
		} else {
			// Another start request may have won the race; read its authoritative time.
			if err = s.db.QueryRow(ctx, `SELECT started_at FROM candidate_sessions WHERE id=$1 AND status='IN_PROGRESS'`, c.Param("session_id")).Scan(&started); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to start assessment timer"})
				return
			}
			startedAt = &started
		}
	}
	expiresAt := startedAt.Add(time.Duration(durationMinutes) * time.Minute)
	if !now.Before(expiresAt) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Exam timer has expired"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"started_at": startedAt, "timer_expires_at": expiresAt, "duration_minutes": durationMinutes, "server_time": now})
}

func constantTimeCodeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

func (s *Server) SubmitSession(c *gin.Context) {
	ctx := c.Request.Context()
	var req struct {
		Answers []struct {
			QuestionID        string   `json:"question_id" binding:"required"`
			SelectedOptionID  string   `json:"selected_option_id"`
			SelectedOptionIDs []string `json:"selected_option_ids"`
			TypedResponse     *string  `json:"typed_response"`
		} `json:"answers"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var assessmentID, studentID, paperID, status string
	var startedAt *time.Time
	var durationMinutes int
	err := s.db.QueryRow(ctx, `SELECT cs.assessment_id::text,cs.student_id::text,cs.paper_id::text,cs.status,cs.started_at,e.duration_minutes FROM candidate_sessions cs JOIN assessment_events e ON e.id=cs.assessment_id WHERE cs.id=$1`, c.Param("session_id")).Scan(&assessmentID, &studentID, &paperID, &status, &startedAt, &durationMinutes)
	if err != nil || status != "IN_PROGRESS" {
		c.JSON(409, gin.H{"error": "No active assessment session"})
		return
	}
	if startedAt == nil || !time.Now().Before(startedAt.Add(time.Duration(durationMinutes)*time.Minute)) {
		c.JSON(403, gin.H{"error": "Exam timer has expired"})
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to save answers"})
		return
	}
	defer tx.Rollback(ctx)
	for _, answer := range req.Answers {
		optionIDs := answer.SelectedOptionIDs
		if len(optionIDs) == 0 && answer.SelectedOptionID != "" {
			optionIDs = []string{answer.SelectedOptionID}
		}
		var qtype string
		err = tx.QueryRow(ctx, `SELECT q.q_type FROM paper_questions pq JOIN questions q ON q.id=pq.question_id WHERE pq.paper_id=$1 AND q.id=$2`, paperID, answer.QuestionID).Scan(&qtype)
		if err != nil {
			c.JSON(400, gin.H{"error": "Answer includes a question outside this paper"})
			return
		}
		if qtype == "MCQ" {
			if len(optionIDs) == 0 || answer.TypedResponse != nil {
				c.JSON(400, gin.H{"error": "MCQ answer requires one or more selected option ids"})
				return
			}
			seen := make(map[string]bool, len(optionIDs))
			for _, optionID := range optionIDs {
				var valid bool
				if optionID == "" || seen[optionID] {
					c.JSON(400, gin.H{"error": "Selected options must be unique"})
					return
				}
				seen[optionID] = true
				if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mcq_options WHERE question_id=$1 AND id=$2)`, answer.QuestionID, optionID).Scan(&valid); err != nil || !valid {
					c.JSON(400, gin.H{"error": "Selected option does not belong to question"})
					return
				}
			}
		} else if qtype == "FIB" {
			if answer.TypedResponse == nil || strings.TrimSpace(*answer.TypedResponse) == "" || len(optionIDs) > 0 || answer.SelectedOptionID != "" {
				c.JSON(400, gin.H{"error": "Fill-in-the-blank answer requires typed_response only"})
				return
			}
		} else {
			c.JSON(400, gin.H{"error": "Unsupported question type"})
			return
		}
		_, err = tx.Exec(ctx, `INSERT INTO candidate_session_answers(session_id,question_id,selected_option_id,selected_option_ids,typed_response) VALUES($1,$2,NULLIF($3,'')::uuid,NULLIF(ARRAY(SELECT unnest($4::text[])::uuid), '{}'::uuid[]),$5) ON CONFLICT(session_id,question_id) DO UPDATE SET selected_option_id=EXCLUDED.selected_option_id,selected_option_ids=EXCLUDED.selected_option_ids,typed_response=EXCLUDED.typed_response,answered_at=NOW()`, c.Param("session_id"), answer.QuestionID, firstOptionID(optionIDs), optionIDs, answer.TypedResponse)
		if err != nil {
			c.JSON(500, gin.H{"error": "Unable to save answers"})
			return
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE candidate_sessions SET status='SUBMITTED' WHERE id=$1 AND status='IN_PROGRESS'`, c.Param("session_id"))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to submit assessment"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(409, gin.H{"error": "Assessment session was already submitted"})
		return
	}
	if err = tx.Commit(ctx); err != nil {
		c.JSON(500, gin.H{"error": "Unable to finalize submission"})
		return
	}
	event := AssessmentSubmittedEvent{SessionID: c.Param("session_id"), StudentID: studentID, BlueprintID: assessmentID, SubmittedAt: time.Now()}
	body, _ := json.Marshal(event)
	if err = s.mqChan.PublishWithContext(ctx, "", "assessment_submissions", false, false, amqp.Publishing{ContentType: "application/json", DeliveryMode: amqp.Persistent, Body: body}); err != nil {
		c.JSON(500, gin.H{"error": "Submission saved but grading could not be queued"})
		return
	}
	c.JSON(202, gin.H{"message": "Submission received and queued for grading", "session_id": c.Param("session_id")})
}
