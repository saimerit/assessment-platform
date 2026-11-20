package main

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type sessionRecord struct {
	ID, AssessmentID, PaperID, StudentID, ProctorID, Status, Mode, OrgID string
	Start, End                                                           time.Time
	StartedAt                                                            *time.Time
	DurationMinutes                                                      int
}

func (s *Server) FetchSessionQuestions(c *gin.Context) {
	ctx := c.Request.Context()
	a := currentAttempt(c)
	l, err := loadLifecycle(ctx, s.db, a, false)
	now, clockErr := attemptNow(ctx, s.db)
	if err == nil {
		err = clockErr
	}
	if err == nil {
		err = l.validate(now, true)
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	questions, err := readAttemptPaper(ctx, s.db, a)
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	c.JSON(200, gin.H{"session_id": a.ID, "started_at": l.StartedAt, "timer_expires_at": l.Deadline, "duration_minutes": l.Duration, "server_time": now, "questions": questions})
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
	now := time.Now()
	lifecycle, err := loadLifecycle(ctx, s.db, currentAttempt(c), false)
	if err == nil {
		err = lifecycle.validate(now, false)
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}
	v.DurationMinutes = lifecycle.Duration
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
	tag, err := s.db.Exec(ctx, `UPDATE candidate_sessions SET status='IN_PROGRESS',unlocked_at=COALESCE(unlocked_at,$2) WHERE id=$1 AND status IN ('INVITED','IN_PROGRESS')`, v.ID, now)
	if err != nil || tag.RowsAffected() != 1 {
		c.JSON(500, gin.H{"error": "Unable to unlock assessment"})
		return
	}
	a := currentAttempt(c)
	a.UnlockedAt = &now
	s.respondAttemptCredentials(c, a, gin.H{"status": "UNLOCKED", "session_id": v.ID, "assessment_id": v.AssessmentID, "proctoring_mode": v.Mode, "duration_minutes": v.DurationMinutes, "server_time": now.UTC(), "unlocked_at": now.Format(time.RFC3339)})
}

// BeginExamSession starts the candidate's duration timer after the candidate
// reviews the outline and explicitly enters the exam. The scheduled window is
// checked only when the timer has not started yet; a started attempt may finish
// within its duration even if the invitation window closes meanwhile.
func (s *Server) BeginExamSession(c *gin.Context) { s.startAttempt(c) }

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

func (s *Server) SubmitSession(c *gin.Context) { s.submitAttempt(c) }
