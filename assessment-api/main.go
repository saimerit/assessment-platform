package main

import (
	"context"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
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
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

type Server struct {
	db     *pgxpool.Pool
	rdb    *redis.Client
	mqChan *amqp.Channel
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
	InstanceID  string    `json:"instance_id"`
	SessionID   string    `json:"session_id,omitempty"`
	StudentID   string    `json:"student_id"`
	BlueprintID string    `json:"blueprint_id"`
	SubmittedAt time.Time `json:"submitted_at"`
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
	BlueprintID     string          `json:"blueprint_id" binding:"required"`
	StudentID       string          `json:"student_id" binding:"required"`
	ViolationType   string          `json:"violation_type" binding:"required"`
	ReportedBy      string          `json:"reported_by" binding:"required"` // e.g. "CLIENT_LOCKDOWN"
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
	var mqConn *amqp.Connection
	for attempt := 1; ; attempt++ {
		mqConn, err = amqp.Dial(cfg.RabbitMQURL)
		if err == nil {
			break
		}
		log.Printf("RabbitMQ not ready (attempt %d): %v; retrying in 2 seconds", attempt, err)
		time.Sleep(2 * time.Second)
	}
	defer mqConn.Close()

	mqChan, err := mqConn.Channel()
	if err != nil {
		log.Fatalf("Unable to open RabbitMQ channel: %v\n", err)
	}
	defer mqChan.Close()

	// Evaluation queue
	_, err = mqChan.QueueDeclare(
		"assessment_submissions",
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Fatalf("Failed to declare evaluation queue: %v\n", err)
	}

	// Notification events queue
	_, err = mqChan.QueueDeclare(
		"notification_events",
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Fatalf("Failed to declare notification queue: %v\n", err)
	}

	srv := &Server{db: dbpool, rdb: rdb, mqChan: mqChan}

	// 4. Gin Router Setup
	r := gin.Default()
	r.Use(corsMiddleware())
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	// Public Auth Endpoint
	r.POST("/api/auth/login", srv.handleLogin)
	r.GET("/api/auth/candidate-invitations/:token", srv.GetCandidateOrgInvitation)
	r.POST("/api/auth/candidate-invitations/:token/register", srv.RegisterInvitedCandidate)

	// Public or Client-authenticated incident stream from Electron
	r.POST("/api/proctor/incidents", srv.ReportIncident)
	// Candidate gateway only returns the minimum information needed to verify an invitation.
	r.GET("/api/exg/:token", srv.HandleExamGateway)
	r.GET("/api/system/client-version", srv.GetClientVersion)
	r.GET("/api/exam/sessions/:session_id/questions", srv.FetchSessionQuestions)
	r.POST("/api/exam/sessions/:session_id/unlock", srv.VerifyExamUnlock)
	r.POST("/api/exam/sessions/:session_id/start", srv.BeginExamSession)
	r.POST("/api/exam/sessions/:session_id/submit", srv.SubmitSession)

	// Assessment Execution Routes (Used by Lockdown Desktop Client)
	api := r.Group("/api/assessments")
	{
		api.POST("/:id/verify-passcode", srv.VerifyPasscode)
		api.POST("/:id/start", srv.StartAssessment)
		api.POST("/:id/submit", srv.SubmitAssessment)
	}

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
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("Assessment API failed to start: %v", err)
	}
}

// GetCandidateAssessments returns the authenticated candidate's assignments,
// schedules, and their own graded scores (when available).
func (s *Server) GetCandidateAssessments(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT i.invitation_token, i.blueprint_id::text, b.title, i.scheduled_start, i.scheduled_end,
		       COALESCE(cai.status,i.status), 'BLUEPRINT'::text, NULL::text,
		       COALESCE(cr.total_score,-1), COALESCE(cr.max_score,-1),
		       COALESCE(cr.evaluated_at,'epoch'::timestamptz)
		FROM assessment_invitations i
		JOIN assessment_blueprints b ON i.blueprint_id = b.id
		LEFT JOIN candidate_assessment_instances cai ON cai.blueprint_id=i.blueprint_id AND cai.student_id=i.student_id
		LEFT JOIN candidate_results cr ON cr.instance_id=cai.id
		WHERE i.student_id = $1
		UNION ALL
		SELECT cs.invitation_token, cs.assessment_id::text, e.title, e.scheduled_start, e.scheduled_end,
		       cs.status, 'EVENT'::text, e.mode,
		       COALESCE(csr.score_obtained,-1), COALESCE(csr.max_score,-1),
		       COALESCE(csr.evaluated_at,'epoch'::timestamptz)
		FROM candidate_sessions cs
		JOIN assessment_events e ON e.id=cs.assessment_id
		LEFT JOIN candidate_session_results csr ON csr.session_id=cs.id
		WHERE cs.student_id=$1
		ORDER BY 4 ASC`, c.GetString("user_id"))
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
		var score, maxScore float64
		var evaluatedAt time.Time
		if err := rows.Scan(&token, &assessmentID, &title, &start, &end, &status, &assessmentType, &mode, &score, &maxScore, &evaluatedAt); err != nil {
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
			"score":            score,
			"max_score":        maxScore,
			"evaluated_at":     evaluatedAt,
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

	var isEvent bool
	if err := s.db.QueryRow(c.Request.Context(), `SELECT EXISTS(SELECT 1 FROM assessment_events WHERE id=$1)`, req.BlueprintID).Scan(&isEvent); err == nil && isEvent {
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

	var scheduledStart, scheduledEnd time.Time
	err := s.db.QueryRow(c.Request.Context(), `
		SELECT scheduled_start, scheduled_end
		FROM assessment_invitations
		WHERE blueprint_id = $1
		  AND (NULLIF($2, '')::uuid IS NULL OR student_id = NULLIF($2, '')::uuid)
		  AND status = 'INVITED'
		ORDER BY scheduled_start ASC
		LIMIT 1`, assessmentID, req.StudentID).Scan(&scheduledStart, &scheduledEnd)
	if err != nil {
		if err == pgx.ErrNoRows {
			c.JSON(http.StatusForbidden, gin.H{"error": "No active invitation exists for this assessment"})
		} else {
			log.Printf("[Passcode] Unable to load assessment schedule: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify assessment schedule"})
		}
		return
	}

	now := time.Now()
	if now.Before(scheduledStart) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment window has not opened yet"})
		return
	}
	if !now.Before(scheduledEnd) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment time window has expired"})
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
	validCode := err == nil && activeCode != "" && activeCode == req.Passcode

	// Preserve the individual passcode sent in each candidate invitation email.
	if !validCode && req.StudentID != "" {
		candidateCode, candidateErr := s.rdb.Get(ctx, fmt.Sprintf("passcode:%s:%s", assessmentID, req.StudentID)).Result()
		if candidateErr != nil && candidateErr != redis.Nil {
			log.Printf("[Passcode] Unable to read candidate passcode from Redis: %v", candidateErr)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify passcode"})
			return
		}
		validCode = candidateErr == nil && candidateCode != "" && candidateCode == req.Passcode
	}
	if !validCode {
		log.Printf("[Passcode] Verification rejected for assessment %s", assessmentID)
		c.JSON(http.StatusForbidden, gin.H{"error": "Invalid or expired invigilator passcode"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":        "PASSCODE_VERIFIED",
		"assessment_id": assessmentID,
		"verified_at":   now.Format(time.RFC3339),
	})
}

// Start Assessment & Persist Deterministic Paper
func (s *Server) StartAssessment(c *gin.Context) {
	ctx := c.Request.Context()
	blueprintID := c.Param("id")

	var req struct {
		StudentID string `json:"student_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var scheduledStart, scheduledEnd time.Time
	err := s.db.QueryRow(ctx, `SELECT scheduled_start,scheduled_end FROM assessment_invitations WHERE blueprint_id=$1 AND student_id=$2 AND status='INVITED' ORDER BY scheduled_start LIMIT 1`, blueprintID, req.StudentID).Scan(&scheduledStart, &scheduledEnd)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "No active invitation exists for this assessment"})
		return
	}
	now := time.Now()
	if now.Before(scheduledStart) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment window has not opened yet"})
		return
	}
	if !now.Before(scheduledEnd) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment time window has expired"})
		return
	}

	var instanceID string
	var status string
	err = s.db.QueryRow(ctx, `
		SELECT id, status FROM candidate_assessment_instances 
		WHERE blueprint_id = $1 AND student_id = $2`, blueprintID, req.StudentID).Scan(&instanceID, &status)

	if err == nil {
		questions, fetchErr := s.fetchInstanceQuestions(ctx, instanceID)
		if fetchErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fetchErr.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"instance_id": instanceID, "status": status, "questions": questions})
		return
	}
	if err != pgx.ErrNoRows {
		log.Printf("[Assessment] Failed to look up existing instance: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment instance"})
		return
	}

	questionIDs, genErr := s.generatePaper(ctx, blueprintID, req.StudentID)
	if genErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": genErr.Error()})
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start transaction"})
		return
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx, `
		INSERT INTO candidate_assessment_instances (blueprint_id, student_id, status)
		VALUES ($1, $2, 'IN_PROGRESS')
		ON CONFLICT (blueprint_id, student_id) DO NOTHING
		RETURNING id`, blueprintID, req.StudentID).Scan(&instanceID)
	if err == pgx.ErrNoRows {
		// Another start request won the unique-key race. Reuse its committed instance.
		_ = tx.Rollback(ctx)
		err = s.db.QueryRow(ctx, `
			SELECT id, status FROM candidate_assessment_instances
			WHERE blueprint_id = $1 AND student_id = $2`, blueprintID, req.StudentID).Scan(&instanceID, &status)
		if err != nil {
			log.Printf("[Assessment] Failed to load instance after concurrent start: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment instance"})
			return
		}
		questions, fetchErr := s.fetchInstanceQuestions(ctx, instanceID)
		if fetchErr != nil {
			log.Printf("[Assessment] Failed to load questions for existing instance: %v", fetchErr)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment questions"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"instance_id": instanceID, "status": status, "questions": questions})
		return
	}
	if err != nil {
		log.Printf("[Assessment] Failed to create instance: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create assessment instance"})
		return
	}

	for order, qID := range questionIDs {
		_, err = tx.Exec(ctx, `
			INSERT INTO instance_questions (instance_id, question_id, display_order)
			VALUES ($1, $2, $3)
			ON CONFLICT (instance_id, question_id) DO NOTHING`, instanceID, qID, order+1)
		if err != nil {
			log.Printf("Error mapping question %s to instance %s: %v", qID, instanceID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to map question: %v", err)})
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Transaction commit failed"})
		return
	}

	questions, err := s.fetchInstanceQuestions(ctx, instanceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"instance_id": instanceID, "status": "IN_PROGRESS", "questions": questions})
}

// Submit Assessment & Publish Event to RabbitMQ
func (s *Server) SubmitAssessment(c *gin.Context) {
	ctx := c.Request.Context()
	blueprintID := c.Param("id")

	var req SubmissionPayload
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var instanceID string
	err := s.db.QueryRow(ctx, `
		SELECT id FROM candidate_assessment_instances 
		WHERE blueprint_id = $1 AND student_id = $2 AND status = 'IN_PROGRESS'`,
		blueprintID, req.StudentID).Scan(&instanceID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No active test session found"})
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}
	defer tx.Rollback(ctx)

	for _, ans := range req.Answers {
		var qType string
		if err = tx.QueryRow(ctx, `SELECT q.q_type FROM instance_questions iq JOIN questions q ON q.id=iq.question_id WHERE iq.instance_id=$1 AND q.id=$2`, instanceID, ans.QuestionID).Scan(&qType); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Answer includes a question outside this paper"})
			return
		}
		optionIDs := ans.OptionIDs
		if len(optionIDs) == 0 && ans.OptionID != "" {
			optionIDs = []string{ans.OptionID}
		}
		if (qType == "MCQ" && (len(optionIDs) == 0 || ans.TypedResponse != nil)) || (qType == "FIB" && (ans.TypedResponse == nil || len(optionIDs) > 0 || ans.OptionID != "")) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Answer format does not match question type"})
			return
		}
		if qType == "MCQ" {
			seen := make(map[string]bool, len(optionIDs))
			for _, optionID := range optionIDs {
				var optionBelongsToQuestion bool
				if seen[optionID] || optionID == "" {
					c.JSON(http.StatusBadRequest, gin.H{"error": "Selected options must be unique"})
					return
				}
				seen[optionID] = true
				if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mcq_options WHERE id=$1 AND question_id=$2)`, optionID, ans.QuestionID).Scan(&optionBelongsToQuestion); err != nil || !optionBelongsToQuestion {
					c.JSON(http.StatusBadRequest, gin.H{"error": "Selected option does not belong to question"})
					return
				}
			}
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO candidate_answers (instance_id, question_id, selected_option_id, selected_option_ids, typed_response)
			VALUES ($1, $2, NULLIF($3, '')::uuid, NULLIF(ARRAY(SELECT unnest($4::text[])::uuid), '{}'::uuid[]), $5)
			ON CONFLICT (instance_id, question_id) 
			DO UPDATE SET selected_option_id = EXCLUDED.selected_option_id, selected_option_ids = EXCLUDED.selected_option_ids, typed_response = EXCLUDED.typed_response, answered_at = NOW()`,
			instanceID, ans.QuestionID, firstOptionID(optionIDs), optionIDs, ans.TypedResponse)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to persist answers"})
			return
		}
	}

	_, err = tx.Exec(ctx, `UPDATE candidate_assessment_instances SET status = 'SUBMITTED' WHERE id = $1`, instanceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update session status"})
		return
	}

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Commit failure"})
		return
	}

	event := AssessmentSubmittedEvent{
		InstanceID:  instanceID,
		StudentID:   req.StudentID,
		BlueprintID: blueprintID,
		SubmittedAt: time.Now(),
	}
	eventBytes, _ := json.Marshal(event)

	err = s.mqChan.PublishWithContext(ctx,
		"",
		"assessment_submissions",
		false,
		false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Body:         eventBytes,
		},
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to queue evaluation event"})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"message":     "Submission received and queued for grading",
		"instance_id": instanceID,
	})
}

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
		err = s.mqChan.PublishWithContext(ctx,
			"",
			"notification_events",
			false,
			false,
			amqp.Publishing{
				ContentType:  "application/json",
				DeliveryMode: amqp.Persistent,
				Body:         bodyBytes,
			},
		)
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
	err := s.db.QueryRow(c.Request.Context(), `
		SELECT cs.assessment_id::text, cs.id::text, cs.student_id::text, cs.paper_id::text,
		       ap.paper_code, ap.set_name, cs.started_at, u.full_name, u.email, e.title,
	       e.scheduled_start, e.scheduled_end, e.mode, e.duration_minutes
		FROM candidate_sessions cs
		JOIN assessment_events e ON e.id=cs.assessment_id
		JOIN assessment_papers ap ON ap.id=cs.paper_id
		JOIN users u ON u.id=cs.student_id
		WHERE cs.invitation_token=$1 AND cs.status IN ('INVITED','IN_PROGRESS')`, token).Scan(
		&eventCandidate.AssessmentID, &eventCandidate.SessionID, &eventCandidate.StudentID, &eventCandidate.PaperID,
		&eventCandidate.PaperCode, &eventCandidate.PaperSetName, &eventCandidate.StartedAt,
		&eventCandidate.CandidateName, &eventCandidate.Email, &eventCandidate.ExamTitle,
		&eventCandidate.ScheduledStart, &eventCandidate.ScheduledEnd, &eventCandidate.ProctoringMode, &eventCandidate.DurationMinutes)
	if err == nil {
		now := time.Now().UTC()
		eventCandidate.ServerTime = now
		eventCandidate.WindowStatus = examWindowStatus(now, eventCandidate.ScheduledStart, eventCandidate.ScheduledEnd)
		if eventCandidate.StartedAt != nil {
			expiresAt := eventCandidate.StartedAt.Add(time.Duration(eventCandidate.DurationMinutes) * time.Minute)
			eventCandidate.TimerExpiresAt = &expiresAt
			if now.Before(expiresAt) {
				eventCandidate.WindowStatus = "IN_PROGRESS"
			}
		}
		eventCandidate.BlueprintID = eventCandidate.AssessmentID
		eventCandidate.MinClientVersion = "1.0.0"
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
			COALESCE(b.min_client_version, '1.0.0'),
			COALESCE((SELECT cr.download_url FROM client_releases cr ORDER BY cr.released_at DESC LIMIT 1),
				$2)
		FROM assessment_invitations i
		JOIN users u ON u.id = i.student_id
		JOIN assessment_blueprints b ON b.id = i.blueprint_id
		WHERE i.invitation_token = $1 AND i.status = 'INVITED'`

	var candidate ExamGatewayResponse
	err = s.db.QueryRow(c.Request.Context(), query, token, clientReleaseURL()).Scan(
		&candidate.BlueprintID,
		&candidate.StudentID,
		&candidate.CandidateName,
		&candidate.Email,
		&candidate.ExamTitle,
		&candidate.ScheduledStart,
		&candidate.ScheduledEnd,
		&candidate.MinClientVersion,
		&candidate.LatestClientURL,
	)

	if err != nil {
		log.Printf("[DEBUG HandleExamGateway ERROR]: %v", err)
		c.JSON(http.StatusNotFound, gin.H{"error": "Invitation not found or no longer available"})
		return
	}
	now := time.Now().UTC()
	candidate.ServerTime = now
	candidate.WindowStatus = examWindowStatus(now, candidate.ScheduledStart, candidate.ScheduledEnd)

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
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT COALESCE(q.bank_id::text,''), COALESCE(b.name,'Assessment questions'), q.q_type, q.marks
		FROM candidate_sessions cs
		JOIN paper_questions pq ON pq.paper_id=cs.paper_id
		JOIN questions q ON q.id=pq.question_id
		LEFT JOIN question_banks b ON b.id=q.bank_id
		WHERE cs.id=$1
		ORDER BY MIN(pq.sort_order) OVER (PARTITION BY COALESCE(q.bank_id::text,'')), pq.sort_order`, sessionID)
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

func (s *Server) generatePaper(ctx context.Context, blueprintID, studentID string) ([]string, error) {
	rows, err := s.db.Query(ctx, `
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

	hasher := sha256.New()
	hasher.Write([]byte(blueprintID + ":" + studentID))
	seed := int64(binary.BigEndian.Uint64(hasher.Sum(nil)[:8]))
	rng := rand.New(rand.NewSource(seed))

	var selected []string

	for _, r := range rules {
		qRows, err := s.db.Query(ctx, `
			SELECT q.id FROM questions q
			JOIN subcategories s ON q.subcategory_id = s.id
			WHERE s.topic_id = $1 AND q.difficulty = $2
			ORDER BY q.id ASC`, r.topicID, r.difficulty)
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
