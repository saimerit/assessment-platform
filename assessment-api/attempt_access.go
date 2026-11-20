package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"assessment-api/middleware"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	attemptSession       = "session"
	attemptLegacy        = "legacy"
	attemptContextKey    = "assessment_attempt"
	attemptTokenLifetime = 15 * time.Minute
)

// Both execution models share identity, token scope and unlock policy. Their
// route adapters retain their existing paper/submission formats.
type attemptRecord struct {
	ID, Kind, AssessmentID, StudentID, OrgID, Status  string
	CandidateRole, CandidateOrgID, RegistrationStatus string
	UnlockedAt                                        *time.Time
}

type attemptRepository interface {
	FindInvitation(context.Context, string) (attemptRecord, error)
	FindAttempt(context.Context, string, string) (attemptRecord, error)
}

type postgresAttemptRepository struct{ db *pgxpool.Pool }

const sessionAccessQuery = `SELECT cs.id::text, 'session', cs.assessment_id::text,
	cs.student_id::text, COALESCE(e.org_id::text,''), cs.status, u.role,
	COALESCE(u.org_id::text,''), u.registration_status, cs.unlocked_at
	FROM candidate_sessions cs JOIN assessment_events e ON e.id=cs.assessment_id
	JOIN users u ON u.id=cs.student_id WHERE `

const legacyAccessQuery = `SELECT i.id::text, 'legacy', i.blueprint_id::text,
	i.student_id::text, COALESCE(b.org_id::text,''),
	CASE WHEN i.status='INVITED' THEN COALESCE(ai.status,'INVITED') ELSE i.status END,
	u.role, COALESCE(u.org_id::text,''), u.registration_status, i.unlocked_at
	FROM assessment_invitations i JOIN assessment_blueprints b ON b.id=i.blueprint_id
	JOIN users u ON u.id=i.student_id LEFT JOIN candidate_assessment_instances ai
	ON ai.blueprint_id=i.blueprint_id AND ai.student_id=i.student_id WHERE `

func scanAttempt(row pgx.Row) (attemptRecord, error) {
	var a attemptRecord
	err := row.Scan(&a.ID, &a.Kind, &a.AssessmentID, &a.StudentID, &a.OrgID,
		&a.Status, &a.CandidateRole, &a.CandidateOrgID, &a.RegistrationStatus, &a.UnlockedAt)
	return a, err
}

func (r postgresAttemptRepository) FindInvitation(ctx context.Context, token string) (attemptRecord, error) {
	a, err := scanAttempt(r.db.QueryRow(ctx, sessionAccessQuery+`cs.invitation_token=$1`, token))
	if !errors.Is(err, pgx.ErrNoRows) {
		return a, err
	}
	return scanAttempt(r.db.QueryRow(ctx, legacyAccessQuery+`i.invitation_token=$1`, token))
}

func (r postgresAttemptRepository) FindAttempt(ctx context.Context, kind, id string) (attemptRecord, error) {
	switch kind {
	case attemptSession:
		return scanAttempt(r.db.QueryRow(ctx, sessionAccessQuery+`cs.id=$1`, id))
	case attemptLegacy:
		return scanAttempt(r.db.QueryRow(ctx, legacyAccessQuery+`i.id=$1`, id))
	default:
		return attemptRecord{}, pgx.ErrNoRows
	}
}

type attemptClaims struct {
	AttemptID    string   `json:"attempt_id"`
	Kind         string   `json:"attempt_kind"`
	AssessmentID string   `json:"assessment_id"`
	OrgID        string   `json:"org_id"`
	Operations   []string `json:"operations"`
	jwt.RegisteredClaims
}

type attemptAccessService struct {
	repository attemptRepository
	secret     []byte
	now        func() time.Time
}

func (a attemptRecord) candidateIsEligible() bool {
	return a.CandidateRole == "CANDIDATE" && a.RegistrationStatus == "REGISTERED" &&
		a.OrgID != "" && a.OrgID == a.CandidateOrgID
}

func (a attemptRecord) isFinalized() bool { return a.Status == "SUBMITTED" || a.Status == "EVALUATED" }

func (a attemptRecord) isActive() bool { return a.Status == "INVITED" || a.Status == "IN_PROGRESS" }

func (s *attemptAccessService) issue(a attemptRecord) (string, time.Time, error) {
	now := s.now().UTC()
	expires := now.Add(attemptTokenLifetime)
	operations := []string{"identity", "receipt"}
	if a.isActive() {
		operations = append(operations, "unlock")
		if a.UnlockedAt != nil {
			operations = append(operations, "start", "questions", "submit", "incident", "checkpoint")
		}
	} else if a.isFinalized() {
		operations = append(operations, "submit")
	}
	claims := attemptClaims{
		AttemptID: a.ID, Kind: a.Kind, AssessmentID: a.AssessmentID, OrgID: a.OrgID, Operations: operations,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: "assessment-api", Audience: jwt.ClaimStrings{"assessment-attempt"}, Subject: a.StudentID,
			IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(expires),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
	return token, expires, err
}

func (s *attemptAccessService) parse(header string) (*attemptClaims, error) {
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, errors.New("attempt token required")
	}
	claims := &attemptClaims{}
	_, err := jwt.ParseWithClaims(strings.TrimPrefix(header, "Bearer "), claims,
		func(_ *jwt.Token) (any, error) { return s.secret, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("assessment-api"),
		jwt.WithAudience("assessment-attempt"), jwt.WithExpirationRequired(), jwt.WithTimeFunc(s.now))
	if err != nil {
		return nil, err
	}
	if claims.Subject == "" || claims.AttemptID == "" || claims.AssessmentID == "" || claims.OrgID == "" ||
		(claims.Kind != attemptSession && claims.Kind != attemptLegacy) {
		return nil, errors.New("invalid attempt identity")
	}
	return claims, nil
}

func (s *attemptAccessService) require(kind, operation string) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, err := s.parse(c.GetHeader("Authorization"))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Sign in again to renew assessment access", "code": "ATTEMPT_TOKEN_REQUIRED"})
			return
		}
		allowed := false
		for _, op := range claims.Operations {
			if op == operation || (operation == "identity" && op == "unlock") || (operation == "receipt" && op == "submit") {
				allowed = true
				break
			}
		}
		if !allowed || (kind != "" && claims.Kind != kind) ||
			(kind == attemptSession && claims.AttemptID != c.Param("session_id")) ||
			(kind == attemptLegacy && claims.AssessmentID != c.Param("id")) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "This token does not allow access to this assessment operation"})
			return
		}
		a, err := s.repository.FindAttempt(c.Request.Context(), claims.Kind, claims.AttemptID)
		if err != nil {
			status := http.StatusServiceUnavailable
			if errors.Is(err, pgx.ErrNoRows) {
				status = http.StatusForbidden
			}
			c.AbortWithStatusJSON(status, gin.H{"error": "Unable to authorize assessment access"})
			return
		}
		if a.StudentID != claims.Subject || a.OrgID != claims.OrgID || a.AssessmentID != claims.AssessmentID ||
			!a.candidateIsEligible() || (!a.isActive() && !(a.isFinalized() && (operation == "receipt" || operation == "submit" || operation == "identity"))) || ((operation == "start" || operation == "questions" || operation == "incident" || operation == "checkpoint") && a.UnlockedAt == nil) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Assessment access is no longer permitted"})
			return
		}
		c.Set(attemptContextKey, a)
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

func currentAttempt(c *gin.Context) attemptRecord {
	return c.MustGet(attemptContextKey).(attemptRecord)
}

func allowAttemptCandidate(c *gin.Context, suppliedID string) bool {
	if suppliedID != "" && suppliedID != currentAttempt(c).StudentID {
		c.JSON(http.StatusForbidden, gin.H{"error": "Candidate identity does not match the authorized attempt"})
		return false
	}
	return true
}

// The invitation is a locator, never an execution credential. A current
// candidate identity must match the persisted assignment before exchanging it.
func (s *Server) ExchangeAttemptAccess(c *gin.Context) {
	var req struct {
		InvitationToken string `json:"invitation_token" binding:"required,max=64"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "A valid invitation token is required"})
		return
	}
	a, err := s.attempts.repository.FindInvitation(c.Request.Context(), req.InvitationToken)
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, pgx.ErrNoRows) {
			status = http.StatusForbidden
		}
		c.JSON(status, gin.H{"error": "Unable to authorize this invitation"})
		return
	}
	if a.StudentID != c.GetString("user_id") || a.OrgID != c.GetString("org_id") || !a.candidateIsEligible() || (!a.isActive() && !a.isFinalized()) {
		c.JSON(http.StatusForbidden, gin.H{"error": "This invitation is not available to your candidate account"})
		return
	}
	s.respondAttemptAccess(c, a)
}

func (s *Server) respondAttemptAccess(c *gin.Context, a attemptRecord) {
	s.respondAttemptCredentials(c, a, gin.H{"attempt_id": a.ID, "attempt_kind": a.Kind,
		"assessment_id": a.AssessmentID, "unlocked": a.UnlockedAt != nil})
}

func (s *Server) respondAttemptCredentials(c *gin.Context, a attemptRecord, payload gin.H) {
	token, expires, err := s.attempts.issue(a)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to issue assessment access"})
		return
	}
	c.Header("Cache-Control", "no-store")
	payload["attempt_token"], payload["expires_at"], payload["server_time"] = token, expires, s.attempts.now().UTC()
	payload["unlocked"] = a.UnlockedAt != nil
	c.JSON(http.StatusOK, payload)
}

func (s *Server) registerAttemptRoutes(r *gin.Engine) {
	r.GET("/api/exam/identity", s.attempts.require("", "identity"), func(c *gin.Context) {
		a := currentAttempt(c)
		c.Header("Cache-Control", "no-store")
		c.JSON(200, gin.H{"attempt_id": a.ID, "attempt_kind": a.Kind, "assessment_id": a.AssessmentID, "org_id": a.OrgID, "student_id": a.StudentID})
	})
	access := r.Group("/api/exam/access", limitRequestBody(4096), middleware.AuthMiddleware(), middleware.RequireRoles("CANDIDATE"))
	access.POST("", s.limitAttemptRequests("access", 60, time.Minute), s.ExchangeAttemptAccess)

	sessions := r.Group("/api/exam/sessions/:session_id", limitRequestBody(1024*1024))
	sessions.GET("/questions", s.attempts.require(attemptSession, "questions"), s.FetchSessionQuestions)
	sessions.POST("/unlock", s.attempts.require(attemptSession, "unlock"), s.limitAttemptRequests("unlock", 10, time.Minute), s.VerifyExamUnlock)
	sessions.POST("/start", s.attempts.require(attemptSession, "start"), s.BeginExamSession)
	sessions.POST("/submit", s.attempts.require(attemptSession, "submit"), s.SubmitSession)
	sessions.GET("/receipt", s.attempts.require(attemptSession, "receipt"), s.GetSubmissionReceipt)
	sessions.GET("/checkpoint", s.attempts.require(attemptSession, "checkpoint"), s.GetAttemptCheckpoint)
	sessions.PUT("/checkpoint", s.attempts.require(attemptSession, "checkpoint"), s.SaveAttemptCheckpoint)

	legacy := r.Group("/api/assessments/:id", limitRequestBody(1024*1024))
	legacy.POST("/verify-passcode", s.attempts.require(attemptLegacy, "unlock"), s.limitAttemptRequests("unlock", 10, time.Minute), s.VerifyPasscode)
	legacy.POST("/start", s.attempts.require(attemptLegacy, "start"), s.StartAssessment)
	legacy.POST("/submit", s.attempts.require(attemptLegacy, "submit"), s.SubmitAssessment)
	legacy.GET("/receipt", s.attempts.require(attemptLegacy, "receipt"), s.GetSubmissionReceipt)
	legacy.GET("/checkpoint", s.attempts.require(attemptLegacy, "checkpoint"), s.GetAttemptCheckpoint)
	legacy.PUT("/checkpoint", s.attempts.require(attemptLegacy, "checkpoint"), s.SaveAttemptCheckpoint)
	r.POST("/api/proctor/incidents", limitRequestBody(16*1024), s.attempts.require("", "incident"), s.limitAttemptRequests("incident", 120, time.Minute), s.ReportIncident)
}
