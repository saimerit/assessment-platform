package main

import (
	"context"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"time"

	"assessment-api/middleware"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
	"os"
	"os/signal"
	"syscall"
)

type Server struct {
	db       *pgxpool.Pool
	rdb      *redis.Client
	messages messagePublisher
	attempts *attemptAccessService
	limits   requestLimitStore
}

type CandidateIntakeField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

type LoginRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

type SubmissionPayload struct {
	StudentID string `json:"student_id" binding:"required"`
	Answers   []struct {
		QuestionID    string   `json:"question_id" binding:"required"`
		OptionID      string   `json:"option_id"`
		OptionIDs     []string `json:"option_ids"`
		TypedResponse *string  `json:"typed_response"`
	} `json:"answers" binding:"required"`
}

type AssessmentSubmittedEvent struct {
	SubmissionID string    `json:"submission_id,omitempty"`
	Version      int       `json:"version,omitempty"`
	InstanceID   string    `json:"instance_id"`
	SessionID    string    `json:"session_id,omitempty"`
	StudentID    string    `json:"student_id"`
	BlueprintID  string    `json:"blueprint_id"`
	SubmittedAt  time.Time `json:"submitted_at"`
}

func firstOptionID(optionIDs []string) string {
	if len(optionIDs) == 0 {
		return ""
	}
	return optionIDs[0]
}

type BatchInviteCandidate struct {
	Email    string `json:"email" binding:"required,email"`
	FullName string `json:"full_name" binding:"required"`
}

type BatchInviteRequest struct {
	Candidates     []BatchInviteCandidate `json:"candidates" binding:"required,min=1"`
	ScheduledStart time.Time              `json:"scheduled_start" binding:"required"`
	ScheduledEnd   time.Time              `json:"scheduled_end" binding:"required"`
}

type NotificationEventPayload struct {
	Event             string    `json:"event"`
	RecipientEmail    string    `json:"recipient_email"`
	CandidateName     string    `json:"candidate_name"`
	ExamTitle         string    `json:"exam_title"`
	Passcode          string    `json:"passcode"`
	TemporaryPassword string    `json:"temporary_password,omitempty"`
	ScheduledStart    time.Time `json:"scheduled_start"`
	ScheduledEnd      time.Time `json:"scheduled_end"`
	BlueprintID       string    `json:"blueprint_id"`
	StudentID         string    `json:"student_id"`
	ClientDownloadURL string    `json:"client_download_url"`
	InvitationToken   string    `json:"invitation_token"`
	InvitationURL     string    `json:"invitation_url,omitempty"`
	AssessmentID      string    `json:"assessment_id,omitempty"`
	ProctoringMode    string    `json:"proctoring_mode,omitempty"`
}

type DispatchedInvitation struct {
	CandidateName     string `json:"candidate_name"`
	Email             string `json:"email"`
	InvitationURL     string `json:"invitation_url"`
	TemporaryPassword string `json:"temporary_password,omitempty"`
	Status            string `json:"status,omitempty"`
}

type ProctorIncidentPayload struct {
	BlueprintID     string          `json:"blueprint_id"`
	StudentID       string          `json:"student_id"`
	ViolationType   string          `json:"violation_type" binding:"required,max=64"`
	ReportedBy      string          `json:"reported_by"`
	EvidencePayload json.RawMessage `json:"evidence_payload"`
}

type ExamGatewayResponse struct {
	BlueprintID      string                `json:"blueprint_id"`
	StudentID        string                `json:"student_id"`
	CandidateName    string                `json:"candidate_name"`
	Email            string                `json:"email"`
	ExamTitle        string                `json:"exam_title"`
	ScheduledStart   time.Time             `json:"scheduled_start"`
	ScheduledEnd     time.Time             `json:"scheduled_end"`
	ServerTime       time.Time             `json:"server_time"`
	WindowStatus     string                `json:"window_status"`
	MinClientVersion string                `json:"min_client_version"`
	LatestClientURL  string                `json:"latest_client_url"`
	SessionID        string                `json:"session_id,omitempty"`
	AssessmentID     string                `json:"assessment_id,omitempty"`
	ProctoringMode   string                `json:"proctoring_mode,omitempty"`
	DurationMinutes  int                   `json:"duration_minutes,omitempty"`
	PaperID          string                `json:"paper_id,omitempty"`
	PaperCode        string                `json:"paper_code,omitempty"`
	PaperSetName     string                `json:"paper_set_name,omitempty"`
	StartedAt        *time.Time            `json:"started_at,omitempty"`
	TimerExpiresAt   *time.Time            `json:"timer_expires_at,omitempty"`
	IntakeFields     json.RawMessage       `json:"intake_fields"`
	Sections         []ExamSectionOverview `json:"sections,omitempty"`
}

func examWindowStatus(now, start, end time.Time) string {
	if now.Before(start) {
		return "NOT_OPEN"
	}
	if !now.Before(end) {
		return "CLOSED"
	}
	return "OPEN"
}

type ExamSectionOverview struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	QuestionCount int            `json:"question_count"`
	TotalMarks    int            `json:"total_marks"`
	QuestionTypes map[string]int `json:"question_types"`
	MarksByType   map[string]int `json:"marks_by_type"`
}

func main() {
	ctx := context.Background()
	cfg := loadRuntimeConfig()
	middleware.LoadJWTSecret()

	// The application role has no SELECT permission on the isolated answer vault.
	dbpool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Unable to parse DB config: %v\n", err)
	}
	if err := dbpool.Ping(ctx); err != nil {
		log.Fatalf("Unable to connect to database: %v\n", err)
	}
	defer dbpool.Close()

	// 2. Redis Connection
	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("Unable to parse Redis config: %v", err)
	}
	rdb := redis.NewClient(redisOptions)
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("Unable to connect to Redis: %v\n", err)
	}

	// 3. RabbitMQ Connection & Queue Declarations
	publisher := &RabbitPublisher{url: cfg.RabbitMQURL}
	defer publisher.Close()
	jobsCtx, stopJobs := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopJobs()
	srv := &Server{db: dbpool, rdb: rdb, messages: publisher,
		attempts: &attemptAccessService{repository: postgresAttemptRepository{dbpool}, secret: middleware.JWTSecret, now: time.Now},
		limits:   redisRequestLimitStore{rdb}}

	// 4. Gin Router Setup
	srv.runSubmissionJobs(jobsCtx)
	r := gin.Default()
	// Do not let an untrusted X-Forwarded-For header bypass IP rate limits.
	_ = r.SetTrustedProxies(nil)
	r.Use(corsMiddleware())
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	// Public Auth Endpoint
	r.POST("/api/auth/login", limitRequestBody(4096), srv.limitLoginIP, srv.handleLogin)
	r.GET("/api/auth/candidate-invitations/:token", srv.GetCandidateOrgInvitation)
	r.POST("/api/auth/candidate-invitations/:token/register", srv.RegisterInvitedCandidate)

	// Candidate gateway only returns the minimum information needed to verify an invitation.
	r.GET("/api/exg/:token", srv.HandleExamGateway)
	r.GET("/api/system/client-version", srv.GetClientVersion)
	srv.registerAttemptRoutes(r)

	// Authenticated Management Routes (Admin, Recruiter & Proctoring)
	auth := r.Group("/api")
	auth.Use(middleware.AuthMiddleware())
	{
		// Recruiter & Org Admin Scope
		recruiter := auth.Group("/admin")
		recruiter.Use(middleware.RequireRoles("SUPER_ADMIN", "ORG_ADMIN", "INSTRUCTOR_RECRUITER"))
		{
			recruiter.GET("/dashboard", func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{
					"message": "Recruiter/Admin access granted",
					"role":    c.GetString("role"),
					"user_id": c.GetString("user_id"),
				})
			})
			recruiter.GET("/blueprints", srv.ListBlueprints)
			recruiter.GET("/candidates", srv.ListAdminCandidates)
			recruiter.GET("/candidate-invitations", srv.ListCandidateOrgInvitations)
			recruiter.POST("/candidate-invitations", srv.InviteCandidatesToOrganization)
			recruiter.GET("/results", srv.ListAdminResults)
			recruiter.POST("/assessments/:id/invite-batch", srv.HandleBatchInvite)
			recruiter.GET("/assessments/:id/invitations", srv.GetAssessmentInvitations)
			recruiter.POST("/questions", srv.CreateQuestion)
			recruiter.POST("/questions/bulk", srv.CreateQuestionsBulk)
			recruiter.POST("/blueprints", srv.CreateBlueprint)
			recruiter.GET("/question-banks", srv.ListQuestionBanks)
			recruiter.POST("/question-banks", srv.CreateQuestionBank)
			recruiter.GET("/question-banks/:id/questions", srv.ListBankQuestions)
			recruiter.POST("/proctors", srv.CreateProctor)
			recruiter.GET("/proctors", srv.ListProctors)
			recruiter.POST("/assessment-events", srv.CreateAssessmentEvent)
			recruiter.POST("/assessment-events/:id/passcodes/regenerate", srv.RegenerateEventPasscodes)
			recruiter.POST("/assessment-events/:id/invitations", srv.InviteEventCandidates)
			recruiter.POST("/assessment-events/:id/assign-candidates", srv.AssignEventCandidates)
			recruiter.GET("/assessment-events/:id/invitations", srv.GetAssessmentEventInvitations)
			recruiter.GET("/assessment-events", srv.ListAssessmentEvents)
			recruiter.GET("/proctoring-code", srv.GetAdminProctoringCode)
			recruiter.POST("/proctoring-code", srv.GenerateAdminProctoringCode)
		}

		// Invigilator / Proctor Scope
		proctor := auth.Group("/proctor")
		proctor.Use(middleware.RequireRoles("SUPER_ADMIN", "ORG_ADMIN", "INSTRUCTOR_RECRUITER", "INVIGILATOR_PROCTOR"))
		{
			proctor.GET("/dashboard", func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{
					"message": "Proctor room access granted",
					"role":    c.GetString("role"),
					"user_id": c.GetString("user_id"),
				})
			})
			proctor.GET("/assessments/:id/incidents", srv.GetProctorIncidents)
			proctor.GET("/assessments/:id/passcode", srv.GetProctorPasscode)
			proctor.POST("/assessments/:id/passcode", srv.GenerateProctorPasscode)
			proctor.GET("/assignments", srv.GetProctorAssignments)
			proctor.POST("/assessment-events/:id/passcode", srv.GenerateAssignedEventPasscode)
			proctor.GET("/assessment-events/:id/candidates", srv.GetAssignedEventCandidates)
			proctor.GET("/assessment-events/:id/incidents", srv.GetAssignedEventIncidents)
		}

		candidate := auth.Group("/candidate")
		candidate.Use(middleware.RequireRoles("CANDIDATE"))
		candidate.GET("/assessments", srv.GetCandidateAssessments)
	}

	log.Printf("Assessment API running on :%s", cfg.Port)
	httpServer := &http.Server{Addr: ":" + cfg.Port, Handler: r, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-jobsCtx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("Assessment API failed to start: %v", err)
	}
}

// GetCandidateAssessments returns the authenticated candidate's assignments,
// schedules. Results remain confidential until an explicit publication workflow
// releases them; automatic grading never grants candidate visibility.
func (s *Server) GetCandidateAssessments(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT i.invitation_token, i.blueprint_id::text, b.title, i.scheduled_start, i.scheduled_end,
		       CASE WHEN cai.status='EVALUATED' THEN 'SUBMITTED' ELSE COALESCE(cai.status,i.status) END, 'BLUEPRINT'::text, NULL::text
		FROM assessment_invitations i
		JOIN assessment_blueprints b ON i.blueprint_id = b.id
		LEFT JOIN candidate_assessment_instances cai ON cai.blueprint_id=i.blueprint_id AND cai.student_id=i.student_id
		WHERE i.student_id = $1 AND b.org_id=$2
		UNION ALL
		SELECT cs.invitation_token, cs.assessment_id::text, e.title, e.scheduled_start, e.scheduled_end,
		       CASE WHEN cs.status='EVALUATED' THEN 'SUBMITTED' ELSE cs.status END, 'EVENT'::text, e.mode
		FROM candidate_sessions cs
		JOIN assessment_events e ON e.id=cs.assessment_id
		WHERE cs.student_id=$1 AND e.org_id=$2
		ORDER BY 4 ASC`, c.GetString("user_id"), c.GetString("org_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query assigned assessments"})
		return
	}
	defer rows.Close()

	assessments := make([]gin.H, 0)
	for rows.Next() {
		var token, assessmentID, title, status, assessmentType string
		var mode *string
		var start, end time.Time
		if err := rows.Scan(&token, &assessmentID, &title, &start, &end, &status, &assessmentType, &mode); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read assigned assessments"})
			return
		}
		assessments = append(assessments, gin.H{
			"invitation_token": token,
			"assessment_id":    assessmentID,
			"assessment_type":  assessmentType,
			"exam_title":       title,
			"scheduled_start":  start,
			"scheduled_end":    end,
			"status":           status,
			"proctoring_mode":  mode,
		})
	}
	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read assigned assessments"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"assessments": assessments})
}

func (s *Server) ListBlueprints(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT id::text,title,duration_minutes,total_marks
		FROM assessment_blueprints
		WHERE $1='SUPER_ADMIN' OR org_id IS NULL OR org_id=NULLIF($2,'')::uuid
		ORDER BY title`, c.GetString("role"), c.GetString("org_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment blueprints"})
		return
	}
	defer rows.Close()
	blueprints := make([]gin.H, 0)
	for rows.Next() {
		var id, title string
		var duration, marks int
		if err := rows.Scan(&id, &title, &duration, &marks); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read assessment blueprints"})
			return
		}
		blueprints = append(blueprints, gin.H{"id": id, "title": title, "duration_minutes": duration, "total_marks": marks})
	}
	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read assessment blueprints"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"blueprints": blueprints})
}

func (s *Server) ReportIncident(c *gin.Context) {
	var req ProctorIncidentPayload
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	a := currentAttempt(c)
	if (req.BlueprintID != "" && req.BlueprintID != a.AssessmentID) || (req.StudentID != "" && req.StudentID != a.StudentID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Incident identity does not match the authorized attempt"})
		return
	}
	if a.Status != "IN_PROGRESS" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Incident reporting requires an unlocked active attempt"})
		return
	}
	req.BlueprintID, req.StudentID, req.ReportedBy = a.AssessmentID, a.StudentID, "ELECTRON_LOCKDOWN_CLIENT"

	if a.Kind == attemptSession {
		_, err := s.db.Exec(c.Request.Context(), `INSERT INTO assessment_event_incidents (assessment_id,student_id,reported_by,violation_type,evidence_payload) VALUES ($1,$2,$3,$4,$5)`, req.BlueprintID, req.StudentID, req.ReportedBy, req.ViolationType, req.EvidencePayload)
		if err != nil {
			log.Printf("Failed to record assessment event incident: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to log incident"})
			return
		}
		c.JSON(http.StatusCreated, gin.H{"status": "INCIDENT_LOGGED"})
		return
	}

	query := `
		INSERT INTO proctoring_incident_logs (blueprint_id, student_id, reported_by, violation_type, evidence_payload)
		VALUES ($1, $2, $3, $4, $5)`

	_, err := s.db.Exec(c.Request.Context(), query, req.BlueprintID, req.StudentID, req.ReportedBy, req.ViolationType, req.EvidencePayload)
	if err != nil {
		log.Printf("Failed to record proctoring incident: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to log incident"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"status": "INCIDENT_LOGGED"})
}

func (s *Server) GetProctorIncidents(c *gin.Context) {
	blueprintID := c.Param("id")

	rows, err := s.db.Query(c.Request.Context(), `
		SELECT p.id, u.full_name, u.email, p.violation_type, p.reported_by, p.occurred_at
		FROM proctoring_incident_logs p
		JOIN users u ON p.student_id = u.id
		WHERE p.blueprint_id = $1
		ORDER BY p.occurred_at DESC
		LIMIT 50`, blueprintID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	var logs []gin.H
	for rows.Next() {
		var id, name, email, vType, reportedBy string
		var occurredAt time.Time
		if err := rows.Scan(&id, &name, &email, &vType, &reportedBy, &occurredAt); err == nil {
			logs = append(logs, gin.H{
				"id":             id,
				"candidate_name": name,
				"email":          email,
				"violation_type": vType,
				"reported_by":    reportedBy,
				"occurred_at":    occurredAt.Format(time.RFC3339),
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{"incidents": logs})
}

// GetProctorPasscode returns the active assessment-wide code and its remaining Redis TTL.
func (s *Server) GetProctorPasscode(c *gin.Context) {
	assessmentID := c.Param("id")
	orgID := c.GetString("org_id")
	role := c.GetString("role")

	accessible, err := s.canAccessProctorAssessment(c, assessmentID, orgID, role)
	if err != nil {
		log.Printf("[Proctor] Failed to validate assessment access: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment passcode"})
		return
	}
	if !accessible {
		c.JSON(http.StatusNotFound, gin.H{"error": "Assessment not found"})
		return
	}

	ctx := c.Request.Context()
	key := fmt.Sprintf("proctor_passcode:%s", assessmentID)
	passcode, err := s.rdb.Get(ctx, key).Result()
	if err == redis.Nil || passcode == "" {
		key = "invigilator_passcode:" + assessmentID
		passcode, err = s.rdb.Get(ctx, key).Result()
	}
	if err == redis.Nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "No active proctor passcode"})
		return
	}
	if err != nil {
		log.Printf("[Proctor] Failed to read assessment passcode: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment passcode"})
		return
	}

	ttl, err := s.rdb.PTTL(ctx, key).Result()
	if err != nil {
		log.Printf("[Proctor] Failed to read passcode TTL: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load passcode expiry"})
		return
	}
	if ttl == -2*time.Millisecond || ttl < -2*time.Millisecond {
		c.JSON(http.StatusNotFound, gin.H{"error": "No active proctor passcode"})
		return
	}

	response := gin.H{
		"assessment_id": assessmentID,
		"passcode":      passcode,
		"ttl_seconds":   int64(-1),
		"expires_at":    nil,
	}
	if ttl >= 0 {
		response["ttl_seconds"] = int64(ttl.Seconds())
		response["expires_at"] = time.Now().Add(ttl).UTC()
	}
	c.JSON(http.StatusOK, response)
}

// GenerateProctorPasscode creates or rotates the shared code until the assessment ends.
func (s *Server) GenerateProctorPasscode(c *gin.Context) {
	assessmentID := c.Param("id")
	orgID := c.GetString("org_id")
	role := c.GetString("role")
	accessible, err := s.canAccessProctorAssessment(c, assessmentID, orgID, role)
	if err != nil {
		log.Printf("[Proctor] Failed to validate assessment access: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to generate assessment passcode"})
		return
	}
	if !accessible {
		c.JSON(http.StatusNotFound, gin.H{"error": "Assessment not found"})
		return
	}

	var scheduledEnd time.Time
	err = s.db.QueryRow(c.Request.Context(), `
		SELECT i.scheduled_end
		FROM assessment_invitations i
		JOIN users u ON u.id = i.student_id
		WHERE i.blueprint_id = $1
		  AND i.status = 'INVITED'
		  AND ($3 = 'SUPER_ADMIN' OR u.org_id = NULLIF($2, '')::uuid)
		ORDER BY i.scheduled_end DESC
		LIMIT 1`, assessmentID, orgID, role).Scan(&scheduledEnd)
	if err != nil {
		if err == pgx.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "No scheduled candidate invitations for this assessment"})
		} else {
			log.Printf("[Proctor] Failed to load assessment end time: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment schedule"})
		}
		return
	}
	if !time.Now().Before(scheduledEnd) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment time window has expired"})
		return
	}

	ttl := time.Until(scheduledEnd)
	if ttl < time.Hour {
		ttl = 24 * time.Hour
	}
	passcode := generatePasscode()
	ctx := c.Request.Context()
	_, err = s.rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.Set(ctx, fmt.Sprintf("proctor_passcode:%s", assessmentID), passcode, ttl)
		pipe.Set(ctx, "invigilator_passcode:"+assessmentID, passcode, ttl)
		return nil
	})
	if err != nil {
		log.Printf("[Proctor] Failed to store regenerated assessment passcode: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to store assessment passcode"})
		return
	}

	log.Printf("[Proctor] Assessment passcode generated for blueprint %s", assessmentID)
	c.JSON(http.StatusOK, gin.H{
		"assessment_id": assessmentID,
		"passcode":      passcode,
		"ttl_seconds":   int64(ttl.Seconds()),
		"expires_at":    time.Now().Add(ttl).UTC(),
	})
}

func (s *Server) canAccessProctorAssessment(c *gin.Context, assessmentID, orgID, role string) (bool, error) {
	var accessible bool
	err := s.db.QueryRow(c.Request.Context(), `
		SELECT EXISTS (
			SELECT 1
			FROM assessment_blueprints b
			WHERE b.id = $1
			  AND (
				$3 = 'SUPER_ADMIN'
				OR b.org_id = NULLIF($2, '')::uuid
				OR (b.org_id IS NULL AND EXISTS (
					SELECT 1 FROM assessment_invitations i
					JOIN users u ON u.id = i.student_id
					WHERE i.blueprint_id = b.id
					  AND u.org_id = NULLIF($2, '')::uuid
				))
			  )
		)`, assessmentID, orgID, role).Scan(&accessible)
	return accessible, err
}

// Login Handler with Bcrypt Verification & JWT Issuance
func (s *Server) handleLogin(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
		return
	}
	if !s.allowLoginAccount(c, req.Email) {
		return
	}

	var userID, orgID, passwordHash, fullName, role, registrationStatus string
	query := `SELECT id, COALESCE(org_id::text, ''), password_hash, full_name, role, registration_status FROM users WHERE lower(email) = lower($1)`
	err := s.db.QueryRow(c.Request.Context(), query, req.Email).Scan(&userID, &orgID, &passwordHash, &fullName, &role, &registrationStatus)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}
	if role == "CANDIDATE" && registrationStatus != "REGISTERED" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Complete registration using your organization invitation before signing in"})
		return
	}

	token, err := middleware.GenerateToken(userID, orgID, role, req.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Token generation failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"token": token,
		"user": gin.H{
			"id":        userID,
			"full_name": fullName,
			"email":     req.Email,
			"role":      role,
			"org_id":    orgID,
		},
	})
}

// VerifyPasscode checks an assessment or candidate passcode and enforces its invitation window.
func (s *Server) VerifyPasscode(c *gin.Context) {
	assessmentID := c.Param("id")

	var req struct {
		Passcode  string `json:"passcode" binding:"required"`
		StudentID string `json:"student_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Passcode is required"})
		return
	}
	a := currentAttempt(c)
	if !allowAttemptCandidate(c, req.StudentID) {
		return
	}
	req.StudentID = a.StudentID

	now := time.Now()
	lifecycle, err := loadLifecycle(c.Request.Context(), s.db, a, false)
	if err == nil {
		err = lifecycle.validate(now, false)
	}
	if err != nil {
		respondAttemptError(c, err)
		return
	}

	ctx := c.Request.Context()
	activeCode, err := s.rdb.Get(ctx, fmt.Sprintf("proctor_passcode:%s", assessmentID)).Result()
	if err == redis.Nil || activeCode == "" {
		activeCode, err = s.rdb.Get(ctx, "invigilator_passcode:"+assessmentID).Result()
	}
	if err != nil && err != redis.Nil {
		log.Printf("[Passcode] Unable to read assessment passcode from Redis: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify passcode"})
		return
	}
	validCode := err == nil && activeCode != "" && constantTimeCodeEqual(activeCode, req.Passcode)

	// Preserve the individual passcode sent in each candidate invitation email.
	if !validCode && req.StudentID != "" {
		candidateCode, candidateErr := s.rdb.Get(ctx, fmt.Sprintf("passcode:%s:%s", assessmentID, req.StudentID)).Result()
		if candidateErr != nil && candidateErr != redis.Nil {
			log.Printf("[Passcode] Unable to read candidate passcode from Redis: %v", candidateErr)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify passcode"})
			return
		}
		validCode = candidateErr == nil && candidateCode != "" && constantTimeCodeEqual(candidateCode, req.Passcode)
	}
	if !validCode {
		log.Printf("[Passcode] Verification rejected for assessment %s", assessmentID)
		c.JSON(http.StatusForbidden, gin.H{"error": "Invalid or expired invigilator passcode"})
		return
	}

	tag, err := s.db.Exec(ctx, `UPDATE assessment_invitations SET unlocked_at=COALESCE(unlocked_at,$2) WHERE id=$1 AND status='INVITED'`, a.ID, now)
	if err != nil || tag.RowsAffected() != 1 {
		c.JSON(http.StatusConflict, gin.H{"error": "Unable to unlock this invitation"})
		return
	}
	a.UnlockedAt = &now
	s.respondAttemptCredentials(c, a, gin.H{
		"status":        "PASSCODE_VERIFIED",
		"assessment_id": assessmentID,
		"verified_at":   now.Format(time.RFC3339),
	})
}

// Legacy adapters retain their route shapes and use the shared lifecycle/save rules.
func (s *Server) StartAssessment(c *gin.Context) {
	var req struct {
		StudentID string `json:"student_id"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondAttemptError(c, attemptError(400, "Invalid start request"))
		return
	}
	if !allowAttemptCandidate(c, req.StudentID) {
		return
	}
	s.startAttempt(c)
}
func (s *Server) SubmitAssessment(c *gin.Context) { s.submitAttempt(c) }

// Handle Batch Invites for Candidates
func (s *Server) HandleBatchInvite(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	ctx := c.Request.Context()
	blueprintID := c.Param("id")
	orgID := c.GetString("org_id")

	var req BatchInviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var examTitle string
	err := s.db.QueryRow(ctx, `SELECT title FROM assessment_blueprints WHERE id = $1`, blueprintID).Scan(&examTitle)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Blueprint not found"})
		return
	}

	var invitedCount int
	var skippedCount int
	invitations := make([]DispatchedInvitation, 0, len(req.Candidates))
	masterProctorCode := generatePasscode()
	proctorTTL := time.Until(req.ScheduledEnd)
	if proctorTTL < time.Hour {
		proctorTTL = 24 * time.Hour
	}
	_, err = s.rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.Set(ctx, fmt.Sprintf("proctor_passcode:%s", blueprintID), masterProctorCode, proctorTTL)
		pipe.Set(ctx, fmt.Sprintf("invigilator_passcode:%s", blueprintID), masterProctorCode, proctorTTL)
		return nil
	})
	if err != nil {
		log.Printf("[Invigilation] Failed to store assessment passcode for blueprint %s: %v", blueprintID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to store assessment passcode"})
		return
	}
	// Never write the generated credential to logs; return it only to this authenticated administrator.
	log.Printf("[Invigilation] Assessment-wide passcode generated for blueprint %s", blueprintID)

	for _, cand := range req.Candidates {
		var studentID string
		userQuery := `
			INSERT INTO users (org_id, email, password_hash, full_name, role, registration_status)
			VALUES ($1, lower($2), 'TEMPORARY_ACCESS', $3, 'CANDIDATE', 'INVITED')
			ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
			RETURNING id`
		err = s.db.QueryRow(ctx, userQuery, orgID, cand.Email, cand.FullName).Scan(&studentID)
		if err != nil {
			log.Printf("Failed to resolve user %s: %v", cand.Email, err)
			skippedCount++
			continue
		}

		passcode := generatePasscode()
		tokenBytes := make([]byte, 32)
		if _, err := crand.Read(tokenBytes); err != nil {
			log.Printf("Failed to create invitation token for student %s: %v", studentID, err)
			skippedCount++
			continue
		}
		invitationToken := hex.EncodeToString(tokenBytes)

		inviteQuery := `
			INSERT INTO assessment_invitations (blueprint_id, student_id, invitation_token, scheduled_start, scheduled_end, passcode_hash, status)
			VALUES ($1, $2, $3, $4, $5, $6, 'INVITED')
			ON CONFLICT (blueprint_id, student_id) 
			DO UPDATE SET scheduled_start = EXCLUDED.scheduled_start, 
			              scheduled_end = EXCLUDED.scheduled_end, 
			              invitation_token = EXCLUDED.invitation_token,
			              passcode_hash = EXCLUDED.passcode_hash,
			              status = 'INVITED'`
		_, err = s.db.Exec(ctx, inviteQuery, blueprintID, studentID, invitationToken, req.ScheduledStart, req.ScheduledEnd, passcode)
		if err != nil {
			log.Printf("Failed to record invite for student %s: %v", studentID, err)
			skippedCount++
			continue
		}

		ttl := time.Until(req.ScheduledEnd) + 2*time.Hour
		if ttl < time.Hour {
			ttl = 24 * time.Hour
		}

		s.rdb.Set(ctx, fmt.Sprintf("passcode:%s:%s", blueprintID, studentID), passcode, ttl)

		eventPayload := NotificationEventPayload{
			Event:             "EXAM_INVITATION",
			RecipientEmail:    cand.Email,
			CandidateName:     cand.FullName,
			ExamTitle:         examTitle,
			Passcode:          passcode,
			ScheduledStart:    req.ScheduledStart,
			ScheduledEnd:      req.ScheduledEnd,
			BlueprintID:       blueprintID,
			StudentID:         studentID,
			ClientDownloadURL: clientReleaseURL(),
			InvitationToken:   invitationToken,
			InvitationURL:     buildGatewayURL(invitationToken),
		}

		bodyBytes, _ := json.Marshal(eventPayload)
		err = s.messages.Publish(ctx, "notification_events", newCheckpointUpdateID(), bodyBytes)
		if err != nil {
			log.Printf("Failed to publish RabbitMQ event for %s: %v", cand.Email, err)
		}

		invitedCount++
		invitations = append(invitations, DispatchedInvitation{
			CandidateName: cand.FullName,
			Email:         cand.Email,
			InvitationURL: eventPayload.InvitationURL,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"message":          "Batch invitation processing completed",
		"invited":          invitedCount,
		"skipped":          skippedCount,
		"blueprint":        blueprintID,
		"invitations":      invitations,
		"proctor_passcode": masterProctorCode,
	})
}

func buildGatewayURL(token string) string {
	return publicAppURL() + "/exg/" + url.PathEscape(token)
}

// GetAssessmentInvitations reloads active gateway links for the campaign table.
func (s *Server) GetAssessmentInvitations(c *gin.Context) {
	orgID := c.GetString("org_id")
	role := c.GetString("role")
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT u.full_name, u.email, i.invitation_token
		FROM assessment_invitations i
		JOIN users u ON u.id = i.student_id
		JOIN assessment_blueprints b ON b.id = i.blueprint_id
		WHERE i.blueprint_id = $1
		  AND i.status = 'INVITED'
		  AND ($3 = 'SUPER_ADMIN' OR u.org_id = NULLIF($2, '')::uuid)
		  AND ($3 = 'SUPER_ADMIN' OR b.org_id IS NULL OR b.org_id = NULLIF($2, '')::uuid)
		ORDER BY u.full_name, u.email`, c.Param("id"), orgID, role)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load campaign invitations"})
		return
	}
	defer rows.Close()

	invitations := make([]DispatchedInvitation, 0)
	for rows.Next() {
		var invitation DispatchedInvitation
		var token string
		if err := rows.Scan(&invitation.CandidateName, &invitation.Email, &token); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read campaign invitations"})
			return
		}
		invitation.InvitationURL = buildGatewayURL(token)
		invitations = append(invitations, invitation)
	}
	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read campaign invitations"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"invitations": invitations})
}

func (s *Server) HandleExamGateway(c *gin.Context) {
	token := c.Param("token")
	// Event invitations use candidate_sessions; keep the legacy blueprint
	// invitation query below intact for already-issued links.
	var eventCandidate ExamGatewayResponse
	var eventStatus string
	err := s.db.QueryRow(c.Request.Context(), `
		SELECT cs.assessment_id::text, cs.id::text, cs.student_id::text, cs.paper_id::text,
		       ap.paper_code, ap.set_name, cs.started_at, cs.timer_expires_at, u.full_name, u.email, e.title,
	       e.scheduled_start, e.scheduled_end, e.mode, e.duration_minutes, cs.status
		FROM candidate_sessions cs
		JOIN assessment_events e ON e.id=cs.assessment_id
		JOIN assessment_papers ap ON ap.id=cs.paper_id
		JOIN users u ON u.id=cs.student_id
		WHERE cs.invitation_token=$1 AND cs.status IN ('INVITED','IN_PROGRESS','SUBMITTED','EVALUATED')`, token).Scan(
		&eventCandidate.AssessmentID, &eventCandidate.SessionID, &eventCandidate.StudentID, &eventCandidate.PaperID,
		&eventCandidate.PaperCode, &eventCandidate.PaperSetName, &eventCandidate.StartedAt, &eventCandidate.TimerExpiresAt,
		&eventCandidate.CandidateName, &eventCandidate.Email, &eventCandidate.ExamTitle,
		&eventCandidate.ScheduledStart, &eventCandidate.ScheduledEnd, &eventCandidate.ProctoringMode, &eventCandidate.DurationMinutes, &eventStatus)
	if err == nil {
		now := time.Now().UTC()
		eventCandidate.ServerTime = now
		eventCandidate.WindowStatus = examWindowStatus(now, eventCandidate.ScheduledStart, eventCandidate.ScheduledEnd)
		if eventCandidate.StartedAt != nil && eventCandidate.TimerExpiresAt != nil {
			eventCandidate.DurationMinutes = int(eventCandidate.TimerExpiresAt.Sub(*eventCandidate.StartedAt) / time.Minute)
			eventCandidate.WindowStatus = "EXPIRED"
			if now.Before(*eventCandidate.TimerExpiresAt) {
				eventCandidate.WindowStatus = "IN_PROGRESS"
			}
		}

		if eventStatus == "SUBMITTED" || eventStatus == "EVALUATED" {
			eventCandidate.WindowStatus = "SUBMITTED"
		}
		eventCandidate.BlueprintID = eventCandidate.AssessmentID
		eventCandidate.MinClientVersion = attemptAuthClientVersion
		eventCandidate.LatestClientURL = clientReleaseURL()
		eventCandidate.IntakeFields = json.RawMessage(`[]`)
		eventCandidate.Sections, err = s.loadExamSectionOverview(c, eventCandidate.SessionID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load the assessment outline"})
			return
		}
		c.JSON(http.StatusOK, eventCandidate)
		return
	}

	query := `
		SELECT 
			i.blueprint_id, 
			i.student_id, 
			u.full_name, 
			u.email, 
			b.title, 
			i.scheduled_start, 
			i.scheduled_end,
			COALESCE(b.min_client_version, '1.0.0'), b.duration_minutes, ai.started_at, ai.timer_expires_at, COALESCE(ai.status,i.status),
			COALESCE((SELECT cr.download_url FROM client_releases cr ORDER BY cr.released_at DESC LIMIT 1),
				$2)
		FROM assessment_invitations i
		JOIN users u ON u.id = i.student_id
		JOIN assessment_blueprints b ON b.id = i.blueprint_id
		LEFT JOIN candidate_assessment_instances ai ON ai.blueprint_id=i.blueprint_id AND ai.student_id=i.student_id
		WHERE (ai.status IS NULL OR ai.status IN ('IN_PROGRESS','SUBMITTED','EVALUATED')) AND i.invitation_token = $1 AND i.status = 'INVITED'`

	var candidate ExamGatewayResponse
	var legacyStatus string
	err = s.db.QueryRow(c.Request.Context(), query, token, clientReleaseURL()).Scan(
		&candidate.BlueprintID,
		&candidate.StudentID,
		&candidate.CandidateName,
		&candidate.Email,
		&candidate.ExamTitle,
		&candidate.ScheduledStart,
		&candidate.ScheduledEnd,
		&candidate.MinClientVersion, &candidate.DurationMinutes, &candidate.StartedAt, &candidate.TimerExpiresAt, &legacyStatus,
		&candidate.LatestClientURL,
	)

	if err != nil {
		log.Printf("[DEBUG HandleExamGateway ERROR]: %v", err)
		c.JSON(http.StatusNotFound, gin.H{"error": "Invitation not found or no longer available"})
		return
	}
	candidate.MinClientVersion = requiredAttemptClientVersion(candidate.MinClientVersion)
	now := time.Now().UTC()
	candidate.ServerTime = now
	candidate.WindowStatus = examWindowStatus(now, candidate.ScheduledStart, candidate.ScheduledEnd)
	if candidate.StartedAt != nil && candidate.TimerExpiresAt != nil {
		candidate.DurationMinutes = int(candidate.TimerExpiresAt.Sub(*candidate.StartedAt) / time.Minute)
		candidate.WindowStatus = "EXPIRED"
		if now.Before(*candidate.TimerExpiresAt) {
			candidate.WindowStatus = "IN_PROGRESS"
		}
	}

	if legacyStatus == "SUBMITTED" || legacyStatus == "EVALUATED" {
		candidate.WindowStatus = "SUBMITTED"
	}

	// Default intake schema (Can later be pulled from an org setting once migrated)
	defaultIntake := `[
		{"key": "full_name", "label": "Full Name", "type": "text", "required": true},
		{"key": "student_number", "label": "Roll / Registration Number", "type": "text", "required": true},
		{"key": "phone", "label": "Contact Phone Number", "type": "tel", "required": true}
	]`
	candidate.IntakeFields = json.RawMessage(defaultIntake)

	c.JSON(http.StatusOK, candidate)
}

func (s *Server) loadExamSectionOverview(c *gin.Context, sessionID string) ([]ExamSectionOverview, error) {
	rows, err := s.db.Query(c.Request.Context(), `WITH content AS (
 SELECT q->>'section_id' AS bank,q->>'section_name' AS name,q->>'question_type' AS qtype,(q->>'marks')::int AS marks,(q->>'display_order')::int AS position
 FROM attempt_paper_snapshots snapshot CROSS JOIN jsonb_array_elements(snapshot.questions) q WHERE snapshot.session_id=$1
 UNION ALL
 SELECT COALESCE(q.bank_id::text,''),COALESCE(b.name,'Assessment questions'),q.q_type,q.marks,pq.sort_order
 FROM candidate_sessions cs JOIN paper_questions pq ON pq.paper_id=cs.paper_id JOIN questions q ON q.id=pq.question_id LEFT JOIN question_banks b ON b.id=q.bank_id
 WHERE cs.id=$1 AND NOT EXISTS(SELECT 1 FROM attempt_paper_snapshots WHERE session_id=$1)
 ) SELECT bank,name,qtype,marks FROM content ORDER BY MIN(position) OVER(PARTITION BY bank),position`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sections := make([]ExamSectionOverview, 0)
	sectionIndex := make(map[string]int)
	for rows.Next() {
		var sectionID, sectionName, questionType string
		var marks int
		if err := rows.Scan(&sectionID, &sectionName, &questionType, &marks); err != nil {
			return nil, err
		}
		index, exists := sectionIndex[sectionID]
		if !exists {
			index = len(sections)
			sectionIndex[sectionID] = index
			sections = append(sections, ExamSectionOverview{ID: sectionID, Name: sectionName, QuestionTypes: make(map[string]int), MarksByType: make(map[string]int)})
		}
		sections[index].QuestionCount++
		sections[index].TotalMarks += marks
		sections[index].QuestionTypes[questionType]++
		sections[index].MarksByType[questionType] += marks
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return sections, nil
}

func generatePasscode() string {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 6)
	randomBytes := make([]byte, len(b))
	if _, err := crand.Read(randomBytes); err != nil {
		panic("secure passcode generation failed: " + err.Error())
	}
	for i := range b {
		b[i] = charset[int(randomBytes[i])%len(charset)]
	}
	return fmt.Sprintf("OA-%s", string(b))
}

func generatePaper(ctx context.Context, db attemptDB, blueprintID, studentID string) ([]string, error) {
	rows, err := db.Query(ctx, `
		SELECT topic_id, difficulty, question_count 
		FROM blueprint_rules 
		WHERE blueprint_id = $1`, blueprintID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type rule struct {
		topicID, difficulty string
		count               int
	}
	var rules []rule
	for rows.Next() {
		var r rule
		if err := rows.Scan(&r.topicID, &r.difficulty, &r.count); err != nil {
			return nil, err
		}
		rules = append(rules, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	hasher := sha256.New()
	hasher.Write([]byte(blueprintID + ":" + studentID))
	seed := int64(binary.BigEndian.Uint64(hasher.Sum(nil)[:8]))
	rng := rand.New(rand.NewSource(seed))

	var selected []string

	for _, r := range rules {
		qRows, err := db.Query(ctx, `
			SELECT q.id FROM questions q
			JOIN subcategories s ON q.subcategory_id = s.id
			JOIN topics t ON t.id=s.topic_id
			JOIN assessment_blueprints bp ON bp.id=$3
			LEFT JOIN question_banks bank ON bank.id=q.bank_id
			WHERE s.topic_id = $1 AND q.difficulty = $2 AND t.org_id=bp.org_id
			AND (q.bank_id IS NULL OR bank.org_id=bp.org_id)
			ORDER BY q.id ASC`, r.topicID, r.difficulty, blueprintID)
		if err != nil {
			return nil, err
		}

		var pool []string
		for qRows.Next() {
			var qID string
			if err := qRows.Scan(&qID); err == nil {
				pool = append(pool, qID)
			}
		}
		if err := qRows.Err(); err != nil {
			qRows.Close()
			return nil, err
		}
		qRows.Close()

		if len(pool) < r.count {
			return nil, fmt.Errorf("insufficient questions in topic %s: needed %d, available %d",
				r.topicID, r.count, len(pool))
		}

		rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
		selected = append(selected, pool[:r.count]...)
	}

	rng.Shuffle(len(selected), func(i, j int) { selected[i], selected[j] = selected[j], selected[i] })
	return selected, nil
}

func (s *Server) fetchInstanceQuestions(ctx context.Context, instanceID string) ([]gin.H, error) {
	rows, err := s.db.Query(ctx, `
		SELECT q.id, q.title, q.statement, q.marks, iq.display_order, q.q_type
		FROM instance_questions iq
		JOIN questions q ON iq.question_id = q.id
		WHERE iq.instance_id = $1
		ORDER BY iq.display_order ASC`, instanceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []gin.H
	for rows.Next() {
		var id, title, statement, qType string
		var marks, order int
		if err := rows.Scan(&id, &title, &statement, &marks, &order, &qType); err != nil {
			return nil, err
		}

		var options []gin.H
		if qType == "MCQ" {
			optRows, err := s.db.Query(ctx, `SELECT id, option_text FROM mcq_options WHERE question_id = $1 ORDER BY display_order, id`, id)
			if err != nil {
				return nil, err
			}
			for optRows.Next() {
				var optID, text string
				if err := optRows.Scan(&optID, &text); err != nil {
					optRows.Close()
					return nil, err
				}
				options = append(options, gin.H{"id": optID, "text": text})
			}
			if err := optRows.Err(); err != nil {
				optRows.Close()
				return nil, err
			}
			optRows.Close()
		}

		result = append(result, gin.H{
			"question_id":   id,
			"display_order": order,
			"title":         title,
			"statement":     statement,
			"marks":         marks,
			"question_type": qType,
			"options":       options,
		})
	}
	return result, nil
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}
