package main

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

// These handlers keep organization scoping and event workflow policy out of the
// HTTP routing layer. Only the organization administrator can mutate its roster.
func requireOrgAdmin(c *gin.Context) bool {
	role := c.GetString("role")
	if role != "ORG_ADMIN" && role != "SUPER_ADMIN" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the organization admin can manage assessments and proctors"})
		return false
	}
	if role != "SUPER_ADMIN" && c.GetString("org_id") == "" {
		c.JSON(http.StatusForbidden, gin.H{"error": "User is not assigned to an organization"})
		return false
	}
	return true
}

func orgScope(c *gin.Context) string {
	if c.GetString("role") == "SUPER_ADMIN" {
		return ""
	}
	return c.GetString("org_id")
}

func requireOrganizationAdminForProctoringCode(c *gin.Context) bool {
	if c.GetString("role") != "ORG_ADMIN" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the organization admin can manage the organization proctoring code"})
		return false
	}
	if c.GetString("org_id") == "" || c.GetString("user_id") == "" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Organization admin is not assigned to an organization"})
		return false
	}
	return true
}

func adminProctoringCodeKey(orgID, adminID string) string {
	return fmt.Sprintf("org_admin_proctor_passcode:%s:%s", orgID, adminID)
}

// GetAdminProctoringCode returns the current organization admin's proctoring
// code. The code is independent of assessment_proctors assignments.
func (s *Server) GetAdminProctoringCode(c *gin.Context) {
	if !requireOrganizationAdminForProctoringCode(c) {
		return
	}
	ctx := c.Request.Context()
	key := adminProctoringCodeKey(c.GetString("org_id"), c.GetString("user_id"))
	code, err := s.rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "No active organization proctoring code"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load organization proctoring code"})
		return
	}
	ttl, err := s.rdb.TTL(ctx, key).Result()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load proctoring code expiry"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"passcode":    code,
		"ttl_seconds": int64(ttl.Seconds()),
		"expires_at":  time.Now().Add(ttl).UTC(),
	})
}

// GenerateAdminProctoringCode rotates an organization-wide code for the
// authenticated organization admin. It can proctor offline-proctored events
// without adding the admin as an event-specific proctor.
func (s *Server) GenerateAdminProctoringCode(c *gin.Context) {
	if !requireOrganizationAdminForProctoringCode(c) {
		return
	}
	const ttl = 24 * time.Hour
	code := generatePasscode()
	key := adminProctoringCodeKey(c.GetString("org_id"), c.GetString("user_id"))
	if err := s.rdb.Set(c.Request.Context(), key, code, ttl).Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to generate organization proctoring code"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"passcode":    code,
		"ttl_seconds": int64(ttl.Seconds()),
		"expires_at":  time.Now().Add(ttl).UTC(),
	})
}

func (s *Server) ListQuestionBanks(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `SELECT id::text,name,created_at FROM question_banks WHERE ($1='' OR org_id=NULLIF($1,'')::uuid) ORDER BY name`, orgScope(c))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load question banks"})
		return
	}
	defer rows.Close()
	items := []gin.H{}
	for rows.Next() {
		var id, name string
		var created time.Time
		if rows.Scan(&id, &name, &created) == nil {
			items = append(items, gin.H{"id": id, "name": name, "created_at": created})
		}
	}
	c.JSON(200, gin.H{"question_banks": items})
}

func (s *Server) CreateQuestionBank(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	var req struct {
		Name string `json:"name" binding:"required"`
	}
	if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Name) == "" {
		c.JSON(400, gin.H{"error": "name is required"})
		return
	}
	var id string
	err := s.db.QueryRow(c.Request.Context(), `INSERT INTO question_banks(org_id,name) VALUES(NULLIF($1,'')::uuid,$2) ON CONFLICT (org_id,lower(name)) DO NOTHING RETURNING id::text`, orgScope(c), strings.TrimSpace(req.Name)).Scan(&id)
	if err != nil {
		c.JSON(409, gin.H{"error": "Unable to create question bank; the name may already exist"})
		return
	}
	c.JSON(201, gin.H{"id": id, "name": strings.TrimSpace(req.Name)})
}

func (s *Server) ListBankQuestions(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `SELECT q.id::text,q.title,q.statement,q.q_type,q.difficulty,q.marks FROM questions q JOIN question_banks b ON b.id=q.bank_id WHERE b.id=$1 AND ($2='' OR b.org_id=NULLIF($2,'')::uuid) ORDER BY q.created_at DESC`, c.Param("id"), orgScope(c))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load questions"})
		return
	}
	defer rows.Close()
	items := []gin.H{}
	for rows.Next() {
		var id, title, statement, qt, diff string
		var marks int
		if rows.Scan(&id, &title, &statement, &qt, &diff, &marks) != nil {
			continue
		}
		item := gin.H{"id": id, "title": title, "statement": statement, "question_type": qt, "difficulty": diff, "marks": marks}
		if qt == "MCQ" {
			opts, e := s.db.Query(c.Request.Context(), `SELECT id::text,option_text FROM mcq_options WHERE question_id=$1 ORDER BY display_order,id`, id)
			if e == nil {
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
		}
		items = append(items, item)
	}
	c.JSON(200, gin.H{"questions": items})
}

func (s *Server) CreateProctor(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	var req struct {
		Email    string `json:"email" binding:"required,email"`
		FullName string `json:"full_name" binding:"required"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	password := req.Password
	generated := false
	if password == "" {
		b := make([]byte, 12)
		if _, err := crand.Read(b); err != nil {
			c.JSON(500, gin.H{"error": "Unable to create account"})
			return
		}
		password = "OA-" + hex.EncodeToString(b)[:16]
		generated = true
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to create account"})
		return
	}
	var id string
	err = s.db.QueryRow(c.Request.Context(), `INSERT INTO users(org_id,email,password_hash,full_name,role) VALUES(NULLIF($1,'')::uuid,lower($2),$3,$4,'INVIGILATOR_PROCTOR') ON CONFLICT(email) DO NOTHING RETURNING id::text`, orgScope(c), strings.TrimSpace(req.Email), string(hash), strings.TrimSpace(req.FullName)).Scan(&id)
	if err != nil {
		c.JSON(409, gin.H{"error": "Email is already registered or proctor could not be created"})
		return
	}
	resp := gin.H{"id": id, "email": strings.TrimSpace(req.Email), "full_name": strings.TrimSpace(req.FullName), "role": "INVIGILATOR_PROCTOR"}
	if generated {
		resp["temporary_password"] = password
	}
	invite := NotificationEventPayload{Event: "PROCTOR_INVITE", RecipientEmail: strings.TrimSpace(req.Email), CandidateName: strings.TrimSpace(req.FullName), ExamTitle: "Assessment Proctor Portal", Passcode: password, InvitationURL: publicAppURL() + "/login"}
	inviteBytes, _ := json.Marshal(invite)
	if err := s.messages.Publish(c.Request.Context(), "notification_events", newCheckpointUpdateID(), inviteBytes); err != nil {
		log.Printf("Failed to queue proctor welcome email for account %s: %v", id, err)
		resp["invite_sent"] = false
	} else {
		resp["invite_sent"] = true
	}
	c.JSON(201, resp)
}

func (s *Server) ListProctors(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `SELECT id::text,full_name,email FROM users WHERE role='INVIGILATOR_PROCTOR' AND ($1='' OR org_id=NULLIF($1,'')::uuid) ORDER BY full_name`, orgScope(c))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load proctors"})
		return
	}
	defer rows.Close()
	list := []gin.H{}
	for rows.Next() {
		var id, n, e string
		if rows.Scan(&id, &n, &e) == nil {
			list = append(list, gin.H{"id": id, "full_name": n, "email": e})
		}
	}
	c.JSON(200, gin.H{"proctors": list})
}

type eventPaperInput struct {
	Name        string                   `json:"name"`
	QuestionIDs []string                 `json:"question_ids"`
	Sections    []eventPaperSectionInput `json:"sections"`
}
type eventPaperSectionInput struct {
	BankID      string   `json:"bank_id"`
	Name        string   `json:"name"`
	QuestionIDs []string `json:"question_ids"`
}
type eventPaperGenerationSection struct {
	BankID        string `json:"bank_id"`
	Name          string `json:"name"`
	QuestionCount int    `json:"question_count"`
}
type eventPaperGenerationInput struct {
	Mode     string                        `json:"mode"`
	SetCount int                           `json:"set_count"`
	Sections []eventPaperGenerationSection `json:"sections"`
}
type eventCandidateInput struct {
	Email    string `json:"email" binding:"required,email"`
	FullName string `json:"full_name" binding:"required"`
}

func ensureExternalCandidateAccount(ctx context.Context, tx pgx.Tx, email, fullName string) (string, error) {
	var id, role, orgID string
	err := tx.QueryRow(ctx, `SELECT id::text,role,COALESCE(org_id::text,'') FROM users WHERE lower(email)=lower($1) FOR UPDATE`, email).Scan(&id, &role, &orgID)
	if err == pgx.ErrNoRows {
		err = tx.QueryRow(ctx, `INSERT INTO users(org_id,email,password_hash,full_name,role,registration_status) VALUES(NULL,lower($1),'INVITED',$2,'CANDIDATE','INVITED') RETURNING id::text`, strings.TrimSpace(email), strings.TrimSpace(fullName)).Scan(&id)
		return id, err
	}
	if err != nil {
		return "", err
	}
	if role != "CANDIDATE" || orgID != "" {
		return "", fmt.Errorf("candidate is already attached to an organization or another account role")
	}
	_, err = tx.Exec(ctx, `UPDATE users SET full_name=$2 WHERE id=$1`, id, strings.TrimSpace(fullName))
	return id, err
}

type createEventInput struct {
	Title           string                     `json:"title" binding:"required"`
	Mode            string                     `json:"mode" binding:"required"`
	ScheduledStart  time.Time                  `json:"scheduled_start" binding:"required"`
	ScheduledEnd    time.Time                  `json:"scheduled_end" binding:"required"`
	DurationMinutes int                        `json:"duration_minutes"`
	ProctorIDs      []string                   `json:"proctor_ids"`
	Papers          []eventPaperInput          `json:"papers"`
	PaperGeneration *eventPaperGenerationInput `json:"paper_generation,omitempty"`
}

func createGeneratedEventPaper(ctx context.Context, tx pgx.Tx, eventID, paperCode, setName string, sections []eventPaperGenerationSection) (string, error) {
	var paperID string
	err := tx.QueryRow(ctx, `INSERT INTO assessment_papers(assessment_id,paper_code,set_name) VALUES($1,$2,$3) ON CONFLICT(assessment_id,set_name) DO UPDATE SET paper_code=EXCLUDED.paper_code RETURNING id::text`, eventID, paperCode, setName).Scan(&paperID)
	if err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM paper_questions WHERE paper_id=$1`, paperID); err != nil {
		return "", err
	}
	sortOrder := 1
	for _, section := range sections {
		rows, queryErr := tx.Query(ctx, `SELECT id::text FROM questions WHERE bank_id=$1`, section.BankID)
		if queryErr != nil {
			return "", queryErr
		}
		pool := make([]string, 0)
		for rows.Next() {
			var questionID string
			if scanErr := rows.Scan(&questionID); scanErr != nil {
				rows.Close()
				return "", scanErr
			}
			pool = append(pool, questionID)
		}
		if rows.Err() != nil {
			err = rows.Err()
			rows.Close()
			return "", err
		}
		rows.Close()
		if len(pool) < section.QuestionCount {
			return "", fmt.Errorf("bank %s requires %d questions but only has %d", section.BankID, section.QuestionCount, len(pool))
		}
		if err = secureShuffleQuestionIDs(pool); err != nil {
			return "", err
		}
		for _, questionID := range pool[:section.QuestionCount] {
			if _, err = tx.Exec(ctx, `INSERT INTO paper_questions(paper_id,question_id,sort_order) VALUES($1,$2,$3)`, paperID, questionID, sortOrder); err != nil {
				return "", err
			}
			sortOrder++
		}
	}
	return paperID, nil
}

func secureShuffleQuestionIDs(ids []string) error {
	type randomizedQuestion struct {
		id  string
		key [16]byte
	}
	randomized := make([]randomizedQuestion, len(ids))
	for i, id := range ids {
		randomized[i].id = id
		if _, err := crand.Read(randomized[i].key[:]); err != nil {
			return err
		}
	}
	sort.Slice(randomized, func(i, j int) bool { return bytes.Compare(randomized[i].key[:], randomized[j].key[:]) < 0 })
	for i := range ids {
		ids[i] = randomized[i].id
	}
	return nil
}

func loadEventPaperGenerationRules(ctx context.Context, tx pgx.Tx, eventID string) ([]eventPaperGenerationSection, error) {
	rows, err := tx.Query(ctx, `SELECT bank_id::text,section_name,question_count FROM assessment_paper_generation_rules WHERE assessment_id=$1 ORDER BY section_order`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := make([]eventPaperGenerationSection, 0)
	for rows.Next() {
		var rule eventPaperGenerationSection
		if err := rows.Scan(&rule.BankID, &rule.Name, &rule.QuestionCount); err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

func generateCandidateEventPaper(ctx context.Context, tx pgx.Tx, eventID, candidateID string) (string, error) {
	rules, err := loadEventPaperGenerationRules(ctx, tx, eventID)
	if err != nil {
		return "", err
	}
	if len(rules) == 0 {
		return "", fmt.Errorf("event has no question-bank generation rules")
	}
	randomID := make([]byte, 8)
	if _, err := crand.Read(randomID); err != nil {
		return "", err
	}
	return createGeneratedEventPaper(ctx, tx, eventID, "CAND-"+hex.EncodeToString(randomID), "CANDIDATE-"+candidateID, rules)
}

func (s *Server) CreateAssessmentEvent(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	ctx := c.Request.Context()
	var req createEventInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.Mode = strings.ToUpper(strings.TrimSpace(req.Mode))
	if req.Mode != "ONLINE_PROCTORING" && req.Mode != "OFFLINE_NORMAL" && req.Mode != "OFFLINE_PROCTORING" {
		c.JSON(400, gin.H{"error": "invalid proctoring mode"})
		return
	}
	if !req.ScheduledEnd.After(req.ScheduledStart) {
		c.JSON(400, gin.H{"error": "scheduled_end must be after scheduled_start"})
		return
	}
	if req.DurationMinutes <= 0 {
		req.DurationMinutes = 60
	}
	paperMode := "FIXED_SETS"
	if req.PaperGeneration != nil {
		paperMode = strings.ToUpper(strings.TrimSpace(req.PaperGeneration.Mode))
		if paperMode != "RANDOM_PER_CANDIDATE" && paperMode != "RANDOM_SETS" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "paper generation mode must be RANDOM_PER_CANDIDATE or RANDOM_SETS"})
			return
		}
		if len(req.PaperGeneration.Sections) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "select at least one question bank and question count"})
			return
		}
		if paperMode == "RANDOM_SETS" && (req.PaperGeneration.SetCount < 1 || req.PaperGeneration.SetCount > 100) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "random set count must be between 1 and 100"})
			return
		}
		if paperMode == "RANDOM_PER_CANDIDATE" {
			req.PaperGeneration.SetCount = 0
		}
	} else if len(req.Papers) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provide fixed paper sets or a random paper generation plan"})
		return
	}
	if len(req.ProctorIDs) == 0 {
		c.JSON(400, gin.H{"error": "assign at least one proctor"})
		return
	}
	for i := range req.Papers {
		if strings.TrimSpace(req.Papers[i].Name) == "" {
			req.Papers[i].Name = fmt.Sprintf("SET-%c", 'A'+i)
		}
		if len(req.Papers[i].Sections) > 0 {
			seenQuestionIDs := make(map[string]struct{})
			for _, section := range req.Papers[i].Sections {
				if strings.TrimSpace(section.BankID) == "" || len(section.QuestionIDs) == 0 {
					c.JSON(400, gin.H{"error": "each question-bank section requires a bank and at least one question"})
					return
				}
				for _, qid := range section.QuestionIDs {
					if _, duplicate := seenQuestionIDs[qid]; duplicate {
						c.JSON(400, gin.H{"error": "a question can only be assigned once per paper"})
						return
					}
					seenQuestionIDs[qid] = struct{}{}
					req.Papers[i].QuestionIDs = append(req.Papers[i].QuestionIDs, qid)
				}
			}
		}
		if len(req.Papers[i].QuestionIDs) == 0 {
			c.JSON(400, gin.H{"error": "each paper requires question_ids"})
			return
		}
	}
	org := orgScope(c)
	for _, pid := range req.ProctorIDs {
		var ok bool
		err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='INVIGILATOR_PROCTOR' AND ($2='' OR org_id=NULLIF($2,'')::uuid))`, pid, org).Scan(&ok)
		if err != nil || !ok {
			c.JSON(400, gin.H{"error": "assigned proctor is not in this organization"})
			return
		}
	}
	if req.PaperGeneration != nil {
		seenBanks := make(map[string]struct{}, len(req.PaperGeneration.Sections))
		for i := range req.PaperGeneration.Sections {
			section := &req.PaperGeneration.Sections[i]
			section.BankID = strings.TrimSpace(section.BankID)
			section.Name = strings.TrimSpace(section.Name)
			if section.BankID == "" || section.QuestionCount < 1 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "each generated section needs a bank and a positive question count"})
				return
			}
			if section.Name == "" {
				section.Name = "Question bank"
			}
			if _, exists := seenBanks[section.BankID]; exists {
				c.JSON(http.StatusBadRequest, gin.H{"error": "a question bank can only be used once in a generated paper"})
				return
			}
			seenBanks[section.BankID] = struct{}{}
			var bankAvailable bool
			var questionCount int
			err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM question_banks WHERE id=$1 AND ($2='' OR org_id=NULLIF($2,'')::uuid)), (SELECT COUNT(*) FROM questions WHERE bank_id=$1)`, section.BankID, org).Scan(&bankAvailable, &questionCount)
			if err != nil || !bankAvailable {
				c.JSON(http.StatusBadRequest, gin.H{"error": "question-bank section is unavailable to this organization"})
				return
			}
			if questionCount < section.QuestionCount {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("bank %q has %d questions; %d requested", section.Name, questionCount, section.QuestionCount)})
				return
			}
		}
	}
	for _, paper := range req.Papers {
		for _, section := range paper.Sections {
			var bankAvailable bool
			err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM question_banks WHERE id=$1 AND ($2='' OR org_id=NULLIF($2,'')::uuid))`, section.BankID, org).Scan(&bankAvailable)
			if err != nil || !bankAvailable {
				c.JSON(400, gin.H{"error": "question-bank section is unavailable to this organization"})
				return
			}
			for _, qid := range section.QuestionIDs {
				var questionInBank bool
				err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM questions WHERE id=$1 AND bank_id=$2)`, qid, section.BankID).Scan(&questionInBank)
				if err != nil || !questionInBank {
					c.JSON(400, gin.H{"error": "each section can contain only questions from its selected bank"})
					return
				}
			}
		}
		for _, qid := range paper.QuestionIDs {
			var ok bool
			err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM questions q LEFT JOIN question_banks b ON b.id=q.bank_id LEFT JOIN subcategories sc ON sc.id=q.subcategory_id LEFT JOIN topics t ON t.id=sc.topic_id WHERE q.id=$1 AND ($2='' OR COALESCE(b.org_id,t.org_id)=$2::uuid OR (b.org_id IS NULL AND t.org_id IS NULL)))`, qid, org).Scan(&ok)
			if err != nil || !ok {
				c.JSON(400, gin.H{"error": "paper includes an unavailable question"})
				return
			}
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to create event"})
		return
	}
	defer tx.Rollback(ctx)
	var eventID string
	err = tx.QueryRow(ctx, `INSERT INTO assessment_events(org_id,title,mode,scheduled_start,scheduled_end,duration_minutes,created_by,paper_assignment_mode,random_set_count) VALUES(NULLIF($1,'')::uuid,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`, org, strings.TrimSpace(req.Title), req.Mode, req.ScheduledStart, req.ScheduledEnd, req.DurationMinutes, c.GetString("user_id"), paperMode, func() int {
		if req.PaperGeneration != nil {
			return req.PaperGeneration.SetCount
		}
		return 0
	}()).Scan(&eventID)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to create event"})
		return
	}
	if req.PaperGeneration != nil {
		for i, section := range req.PaperGeneration.Sections {
			if _, err = tx.Exec(ctx, `INSERT INTO assessment_paper_generation_rules(assessment_id,section_order,bank_id,section_name,question_count) VALUES($1,$2,$3,$4,$5)`, eventID, i+1, section.BankID, section.Name, section.QuestionCount); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to save paper generation rules"})
				return
			}
		}
	}
	generatedPaperIDs := make([]string, 0)
	if req.PaperGeneration != nil && paperMode == "RANDOM_SETS" {
		for i := 0; i < req.PaperGeneration.SetCount; i++ {
			setName := fmt.Sprintf("SET-%02d", i+1)
			paperID, generateErr := createGeneratedEventPaper(ctx, tx, eventID, fmt.Sprintf("PAPER-%03d", i+1), setName, req.PaperGeneration.Sections)
			if generateErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to generate randomized question paper"})
				return
			}
			generatedPaperIDs = append(generatedPaperIDs, paperID)
		}
	}
	if paperMode == "FIXED_SETS" {
		for i, p := range req.Papers {
			type randomizedQuestion struct {
				id  string
				key [16]byte
			}
			code := fmt.Sprintf("PAPER-%02d", i+1)
			var paperID string
			err = tx.QueryRow(ctx, `INSERT INTO assessment_papers(assessment_id,paper_code,set_name) VALUES($1,$2,$3) RETURNING id::text`, eventID, code, p.Name).Scan(&paperID)
			if err != nil {
				c.JSON(500, gin.H{"error": "Unable to create event papers"})
				return
			}
			generatedPaperIDs = append(generatedPaperIDs, paperID)
			sortOrder := 1
			insertRandomizedSection := func(questionIDs []string) error {
				randomized := make([]randomizedQuestion, len(questionIDs))
				for j, qid := range questionIDs {
					randomized[j].id = qid
					if _, randomErr := crand.Read(randomized[j].key[:]); randomErr != nil {
						return randomErr
					}
				}
				sort.Slice(randomized, func(a, b int) bool { return bytes.Compare(randomized[a].key[:], randomized[b].key[:]) < 0 })
				for _, question := range randomized {
					if _, insertErr := tx.Exec(ctx, `INSERT INTO paper_questions(paper_id,question_id,sort_order) VALUES($1,$2,$3)`, paperID, question.id, sortOrder); insertErr != nil {
						return insertErr
					}
					sortOrder++
				}
				return nil
			}
			if len(p.Sections) > 0 {
				for _, section := range p.Sections {
					if err = insertRandomizedSection(section.QuestionIDs); err != nil {
						c.JSON(500, gin.H{"error": "Unable to assign questions to bank sections"})
						return
					}
				}
			} else if err = insertRandomizedSection(p.QuestionIDs); err != nil {
				c.JSON(500, gin.H{"error": "Unable to assign paper questions"})
				return
			}
		}
	}
	proctorCodes := make(map[string]string, len(req.ProctorIDs))
	for _, pid := range req.ProctorIDs {
		code := generatePasscode()
		proctorCodes[pid] = code
		hash, _ := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
		if _, err = tx.Exec(ctx, `INSERT INTO assessment_proctors(assessment_id,proctor_id,room_or_group,passcode_hash) VALUES($1,$2,'MAIN',$3)`, eventID, pid, string(hash)); err != nil {
			c.JSON(500, gin.H{"error": "Unable to assign event proctors"})
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		c.JSON(500, gin.H{"error": "Unable to save event"})
		return
	}
	// Event-wide normal/online unlock code is separate from proctor-specific codes.
	ttl := time.Until(req.ScheduledEnd) + 2*time.Hour
	if ttl < time.Hour {
		ttl = 24 * time.Hour
	}
	if req.Mode == "OFFLINE_NORMAL" {
		code := generatePasscode()
		if err = s.rdb.Set(ctx, fmt.Sprintf("event_passcode:%s", eventID), code, ttl).Err(); err != nil {
			c.JSON(500, gin.H{"error": "Event created but unlock code could not be stored"})
			return
		}
	}
	for pid, code := range proctorCodes {
		if err = s.rdb.Set(ctx, fmt.Sprintf("event_proctor_passcode:%s:%s", eventID, pid), code, ttl).Err(); err != nil {
			c.JSON(500, gin.H{"error": "Event created but a proctor code could not be stored"})
			return
		}
	}
	c.JSON(201, gin.H{"assessment_id": eventID, "title": req.Title, "mode": req.Mode, "scheduled_start": req.ScheduledStart, "scheduled_end": req.ScheduledEnd, "paper_assignment_mode": paperMode, "paper_ids": generatedPaperIDs, "status": "CREATED"})
}

func (s *Server) ListAssessmentEvents(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `SELECT id::text,title,mode,scheduled_start,scheduled_end,duration_minutes FROM assessment_events WHERE ($1='' OR org_id=NULLIF($1,'')::uuid) ORDER BY scheduled_start DESC`, orgScope(c))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load events"})
		return
	}
	defer rows.Close()
	items := []gin.H{}
	for rows.Next() {
		var id, title, mode string
		var start, end time.Time
		var duration int
		if rows.Scan(&id, &title, &mode, &start, &end, &duration) == nil {
			items = append(items, gin.H{"id": id, "title": title, "mode": mode, "scheduled_start": start, "scheduled_end": end, "duration_minutes": duration})
		}
	}
	c.JSON(200, gin.H{"events": items})
}

func (s *Server) GetAssessmentEventInvitations(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT u.full_name, u.email, cs.invitation_token, cs.status
		FROM candidate_sessions cs
		JOIN users u ON u.id=cs.student_id
		JOIN assessment_events e ON e.id=cs.assessment_id
		WHERE e.id=$1
		  AND ($2='SUPER_ADMIN' OR e.org_id IS NULL OR e.org_id=NULLIF($3,'')::uuid)
		ORDER BY u.full_name,u.email`, c.Param("id"), c.GetString("role"), c.GetString("org_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load event invitations"})
		return
	}
	defer rows.Close()
	invitations := make([]DispatchedInvitation, 0)
	for rows.Next() {
		var invitation DispatchedInvitation
		if err := rows.Scan(&invitation.CandidateName, &invitation.Email, &invitation.InvitationURL, &invitation.Status); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read event invitations"})
			return
		}
		invitation.InvitationURL = buildGatewayURL(invitation.InvitationURL)
		invitations = append(invitations, invitation)
	}
	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read event invitations"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"invitations": invitations})
}

func (s *Server) RegenerateEventPasscodes(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	ctx := c.Request.Context()
	var mode string
	var scheduledEnd time.Time
	err := s.db.QueryRow(ctx, `SELECT mode,scheduled_end FROM assessment_events WHERE id=$1 AND ($2='' OR org_id=NULLIF($2,'')::uuid)`, c.Param("id"), orgScope(c)).Scan(&mode, &scheduledEnd)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Assessment event not found"})
		return
	}
	ttl := time.Until(scheduledEnd) + 2*time.Hour
	if ttl < time.Hour {
		ttl = 24 * time.Hour
	}
	if mode == "OFFLINE_NORMAL" {
		if err := s.rdb.Set(ctx, fmt.Sprintf("event_passcode:%s", c.Param("id")), generatePasscode(), ttl).Err(); err != nil {
			c.JSON(500, gin.H{"error": "Unable to regenerate event access code"})
			return
		}
	}
	rows, err := s.db.Query(ctx, `SELECT proctor_id::text FROM assessment_proctors WHERE assessment_id=$1`, c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load assigned proctors"})
		return
	}
	defer rows.Close()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to regenerate proctor codes"})
		return
	}
	defer tx.Rollback(ctx)
	for rows.Next() {
		var proctorID string
		if err := rows.Scan(&proctorID); err != nil {
			c.JSON(500, gin.H{"error": "Unable to read assigned proctors"})
			return
		}
		code := generatePasscode()
		hash, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
		if err != nil {
			c.JSON(500, gin.H{"error": "Unable to regenerate proctor codes"})
			return
		}
		if _, err = tx.Exec(ctx, `UPDATE assessment_proctors SET passcode_hash=$3 WHERE assessment_id=$1 AND proctor_id=$2`, c.Param("id"), proctorID, string(hash)); err != nil {
			c.JSON(500, gin.H{"error": "Unable to save regenerated proctor code"})
			return
		}
		if err = s.rdb.Set(ctx, fmt.Sprintf("event_proctor_passcode:%s:%s", c.Param("id"), proctorID), code, ttl).Err(); err != nil {
			c.JSON(500, gin.H{"error": "Unable to store regenerated proctor code"})
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		c.JSON(500, gin.H{"error": "Unable to commit regenerated proctor codes"})
		return
	}
	c.JSON(200, gin.H{"status": "REGENERATED", "assessment_id": c.Param("id"), "mode": mode, "ttl_seconds": int64(ttl.Seconds())})
}

func (s *Server) InviteEventCandidates(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	ctx := c.Request.Context()
	eventID := c.Param("id")
	var req struct {
		Candidates []eventCandidateInput `json:"candidates" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var title, mode, org, paperAssignmentMode string
	var start, end time.Time
	err := s.db.QueryRow(ctx, `SELECT title,mode,scheduled_start,scheduled_end,COALESCE(org_id::text,''),paper_assignment_mode FROM assessment_events WHERE id=$1 AND ($2='' OR org_id=NULLIF($2,'')::uuid)`, eventID, orgScope(c)).Scan(&title, &mode, &start, &end, &org, &paperAssignmentMode)
	if err != nil {
		c.JSON(404, gin.H{"error": "Event not found"})
		return
	}
	var papers, proctors []string
	rows, err := s.db.Query(ctx, `SELECT id::text FROM assessment_papers WHERE assessment_id=$1 ORDER BY paper_code`, eventID)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load papers"})
		return
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			papers = append(papers, id)
		}
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `SELECT proctor_id::text FROM assessment_proctors WHERE assessment_id=$1 ORDER BY proctor_id`, eventID)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load proctors"})
		return
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			proctors = append(proctors, id)
		}
	}
	rows.Close()
	if (len(papers) == 0 && paperAssignmentMode != "RANDOM_PER_CANDIDATE") || len(proctors) == 0 {
		c.JSON(409, gin.H{"error": "Event requires at least one paper and one proctor"})
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to invite candidates"})
		return
	}
	defer tx.Rollback(ctx)
	invites := []DispatchedInvitation{}
	for i, cand := range req.Candidates {
		student, accountErr := ensureExternalCandidateAccount(ctx, tx, cand.Email, cand.FullName)
		err = accountErr
		if err != nil {
			c.JSON(409, gin.H{"error": "Candidate email is already associated with an organization or another account role. Use the in-organization assignment tab for registered candidates."})
			return
		}
		tokenBytes := make([]byte, 32)
		if _, err = crand.Read(tokenBytes); err != nil {
			c.JSON(500, gin.H{"error": "Unable to create invitation"})
			return
		}
		token := hex.EncodeToString(tokenBytes)
		paperID := ""
		if paperAssignmentMode == "RANDOM_PER_CANDIDATE" {
			paperID, err = generateCandidateEventPaper(ctx, tx, eventID, student)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to generate this candidate's question paper"})
				return
			}
		} else {
			paperID = papers[i%len(papers)]
		}
		tag, err := tx.Exec(ctx, `INSERT INTO candidate_sessions(assessment_id,paper_id,student_id,invitation_token,assigned_proctor_id,status) VALUES($1,$2,$3,$4,$5,'INVITED') ON CONFLICT(assessment_id,student_id) DO UPDATE SET paper_id=EXCLUDED.paper_id,invitation_token=EXCLUDED.invitation_token,assigned_proctor_id=EXCLUDED.assigned_proctor_id,status='INVITED',started_at=NULL WHERE candidate_sessions.status IN ('INVITED','EXPIRED')`, eventID, paperID, student, token, proctors[i%len(proctors)])
		if err != nil || tag.RowsAffected() == 0 {
			c.JSON(409, gin.H{"error": "Candidate already has an active or completed session for this event"})
			return
		}
		invites = append(invites, DispatchedInvitation{CandidateName: cand.FullName, Email: cand.Email, InvitationURL: buildGatewayURL(token)})
	}
	if err = tx.Commit(ctx); err != nil {
		c.JSON(500, gin.H{"error": "Unable to save candidate invitations"})
		return
	}
	for i, cand := range req.Candidates {
		if i >= len(invites) {
			break
		}
		payload := NotificationEventPayload{Event: "EXAM_INVITATION", RecipientEmail: cand.Email, CandidateName: cand.FullName, ExamTitle: title, ScheduledStart: start, ScheduledEnd: end, AssessmentID: eventID, ProctoringMode: mode, InvitationToken: strings.TrimPrefix(invites[i].InvitationURL, buildGatewayURL("")), InvitationURL: invites[i].InvitationURL, TemporaryPassword: invites[i].TemporaryPassword, ClientDownloadURL: clientReleaseURL()}
		body, _ := json.Marshal(payload)
		_ = s.messages.Publish(ctx, "notification_events", newCheckpointUpdateID(), body)
	}
	c.JSON(200, gin.H{"assessment_id": eventID, "invited": len(invites), "invitations": invites})
}

// AssignEventCandidates assigns registered candidates belonging to the same
// organization to a scheduled event without creating placeholder accounts.
func (s *Server) AssignEventCandidates(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	ctx := c.Request.Context()
	eventID := c.Param("id")
	var req struct {
		CandidateIDs []string `json:"candidate_ids" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var title, mode, eventOrg, paperAssignmentMode string
	var start, end time.Time
	err := s.db.QueryRow(ctx, `SELECT title,mode,scheduled_start,scheduled_end,COALESCE(org_id::text,''),paper_assignment_mode FROM assessment_events WHERE id=$1 AND ($2='' OR org_id=NULLIF($2,'')::uuid)`, eventID, orgScope(c)).Scan(&title, &mode, &start, &end, &eventOrg, &paperAssignmentMode)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Assessment event not found"})
		return
	}
	var papers, proctors []string
	rows, err := s.db.Query(ctx, `SELECT id::text FROM assessment_papers WHERE assessment_id=$1 ORDER BY paper_code`, eventID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load event papers"})
		return
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			papers = append(papers, id)
		}
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `SELECT proctor_id::text FROM assessment_proctors WHERE assessment_id=$1 ORDER BY proctor_id`, eventID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load event proctors"})
		return
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			proctors = append(proctors, id)
		}
	}
	rows.Close()
	if (len(papers) == 0 && paperAssignmentMode != "RANDOM_PER_CANDIDATE") || len(proctors) == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "Event requires at least one paper and one proctor"})
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to assign candidates"})
		return
	}
	defer tx.Rollback(ctx)
	invites := make([]DispatchedInvitation, 0, len(req.CandidateIDs))
	seenCandidateIDs := make(map[string]struct{}, len(req.CandidateIDs))
	for i, candidateID := range req.CandidateIDs {
		if _, duplicate := seenCandidateIDs[candidateID]; duplicate {
			c.JSON(http.StatusBadRequest, gin.H{"error": "A candidate can only be assigned once per request"})
			return
		}
		seenCandidateIDs[candidateID] = struct{}{}
		var fullName, email string
		err = tx.QueryRow(ctx, `SELECT full_name,email FROM users WHERE id=$1 AND role='CANDIDATE' AND registration_status='REGISTERED' AND org_id=NULLIF($2,'')::uuid FOR UPDATE`, candidateID, eventOrg).Scan(&fullName, &email)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Select registered candidates from this organization only"})
			return
		}
		tokenBytes := make([]byte, 32)
		if _, err = crand.Read(tokenBytes); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to create exam invitation"})
			return
		}
		token := hex.EncodeToString(tokenBytes)
		paperID := ""
		if paperAssignmentMode == "RANDOM_PER_CANDIDATE" {
			paperID, err = generateCandidateEventPaper(ctx, tx, eventID, candidateID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to generate this candidate's question paper"})
				return
			}
		} else {
			paperID = papers[i%len(papers)]
		}
		tag, execErr := tx.Exec(ctx, `INSERT INTO candidate_sessions(assessment_id,paper_id,student_id,invitation_token,assigned_proctor_id,status) VALUES($1,$2,$3,$4,$5,'INVITED') ON CONFLICT(assessment_id,student_id) DO UPDATE SET paper_id=EXCLUDED.paper_id,invitation_token=EXCLUDED.invitation_token,assigned_proctor_id=EXCLUDED.assigned_proctor_id,status='INVITED',started_at=NULL WHERE candidate_sessions.status IN ('INVITED','EXPIRED')`, eventID, paperID, candidateID, token, proctors[i%len(proctors)])
		if execErr != nil || tag.RowsAffected() == 0 {
			c.JSON(http.StatusConflict, gin.H{"error": "A selected candidate already has an active or completed session for this event"})
			return
		}
		invites = append(invites, DispatchedInvitation{CandidateName: fullName, Email: email, InvitationURL: buildGatewayURL(token)})
	}
	if err = tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to save candidate assignments"})
		return
	}
	for _, invite := range invites {
		token := strings.TrimPrefix(invite.InvitationURL, buildGatewayURL(""))
		payload := NotificationEventPayload{Event: "EXAM_INVITATION", RecipientEmail: invite.Email, CandidateName: invite.CandidateName, ExamTitle: title, ScheduledStart: start, ScheduledEnd: end, AssessmentID: eventID, ProctoringMode: mode, InvitationToken: token, InvitationURL: invite.InvitationURL, ClientDownloadURL: clientReleaseURL()}
		body, _ := json.Marshal(payload)
		_ = s.messages.Publish(ctx, "notification_events", newCheckpointUpdateID(), body)
	}
	c.JSON(http.StatusOK, gin.H{"assessment_id": eventID, "assigned": len(invites), "invitations": invites})
}

func (s *Server) GetProctorAssignments(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `SELECT e.id::text,e.title,e.mode,e.scheduled_start,e.scheduled_end,ap.room_or_group FROM assessment_proctors ap JOIN assessment_events e ON e.id=ap.assessment_id WHERE ap.proctor_id=$1 ORDER BY e.scheduled_start`, c.GetString("user_id"))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load proctor assignments"})
		return
	}
	defer rows.Close()
	list := []gin.H{}
	for rows.Next() {
		var id, title, mode, room string
		var start, end time.Time
		if rows.Scan(&id, &title, &mode, &start, &end, &room) != nil {
			continue
		}
		entry := gin.H{"assessment_id": id, "title": title, "mode": mode, "scheduled_start": start, "scheduled_end": end, "room_or_group": room}
		key := fmt.Sprintf("event_passcode:%s", id)
		if mode == "ONLINE_PROCTORING" || mode == "OFFLINE_PROCTORING" {
			key = fmt.Sprintf("event_proctor_passcode:%s:%s", id, c.GetString("user_id"))
		}
		if code, e := s.rdb.Get(c.Request.Context(), key).Result(); e == nil {
			entry["passcode"] = code
			ttl := s.rdb.TTL(c.Request.Context(), key).Val()
			if ttl >= 0 {
				entry["ttl_seconds"] = int64(ttl.Seconds())
			}
		}
		list = append(list, entry)
	}
	c.JSON(200, gin.H{"assignments": list})
}

// GenerateAssignedEventPasscode rotates the private access code for the
// authenticated proctor's own proctored event assignment.
func (s *Server) GenerateAssignedEventPasscode(c *gin.Context) {
	ctx := c.Request.Context()
	eventID := c.Param("id")
	proctorID := c.GetString("user_id")

	var mode string
	var scheduledEnd time.Time
	err := s.db.QueryRow(ctx, `
		SELECT e.mode, e.scheduled_end
		FROM assessment_events e
		JOIN assessment_proctors ap ON ap.assessment_id = e.id
		WHERE e.id = $1 AND ap.proctor_id = $2`, eventID, proctorID).Scan(&mode, &scheduledEnd)
	if err != nil {
		if err == pgx.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "This assessment is not assigned to your proctor account"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify proctor assignment"})
		}
		return
	}
	if !time.Now().Before(scheduledEnd) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Assessment time window has expired"})
		return
	}

	ttl := time.Until(scheduledEnd) + 2*time.Hour
	if ttl < time.Hour {
		ttl = 24 * time.Hour
	}
	code := generatePasscode()
	hash, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to secure proctor passcode"})
		return
	}
	key := fmt.Sprintf("event_passcode:%s", eventID)
	if mode == "ONLINE_PROCTORING" || mode == "OFFLINE_PROCTORING" {
		if _, err = s.db.Exec(ctx, `UPDATE assessment_proctors SET passcode_hash=$3 WHERE assessment_id=$1 AND proctor_id=$2`, eventID, proctorID, string(hash)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to save proctor passcode"})
			return
		}
		key = fmt.Sprintf("event_proctor_passcode:%s:%s", eventID, proctorID)
	}
	if err = s.rdb.Set(ctx, key, code, ttl).Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to activate proctor passcode"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"assessment_id": eventID,
		"passcode":      code,
		"ttl_seconds":   int64(ttl.Seconds()),
		"expires_at":    time.Now().Add(ttl).UTC(),
	})
}

func (s *Server) GetAssignedEventCandidates(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `SELECT u.id::text,u.full_name,u.email,cs.status FROM candidate_sessions cs JOIN users u ON u.id=cs.student_id JOIN assessment_proctors ap ON ap.assessment_id=cs.assessment_id AND ap.proctor_id=cs.assigned_proctor_id WHERE cs.assessment_id=$1 AND cs.assigned_proctor_id=$2 ORDER BY u.full_name`, c.Param("id"), c.GetString("user_id"))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load assigned candidates"})
		return
	}
	defer rows.Close()
	items := []gin.H{}
	for rows.Next() {
		var id, name, email, status string
		if rows.Scan(&id, &name, &email, &status) == nil {
			items = append(items, gin.H{"candidate_id": id, "candidate_name": name, "email": email, "status": status})
		}
	}
	c.JSON(200, gin.H{"candidates": items})
}

func (s *Server) GetAssignedEventIncidents(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `SELECT i.id::text,u.full_name,u.email,i.violation_type,i.reported_by,i.occurred_at FROM assessment_event_incidents i JOIN users u ON u.id=i.student_id JOIN assessment_proctors ap ON ap.assessment_id=i.assessment_id AND ap.proctor_id=$2 WHERE i.assessment_id=$1 ORDER BY i.occurred_at DESC LIMIT 100`, c.Param("id"), c.GetString("user_id"))
	if err != nil {
		c.JSON(500, gin.H{"error": "Unable to load event incidents"})
		return
	}
	defer rows.Close()
	items := []gin.H{}
	for rows.Next() {
		var id, name, email, violation, reported string
		var occurred time.Time
		if rows.Scan(&id, &name, &email, &violation, &reported, &occurred) == nil {
			items = append(items, gin.H{"id": id, "candidate_name": name, "email": email, "violation_type": violation, "reported_by": reported, "occurred_at": occurred})
		}
	}
	c.JSON(200, gin.H{"incidents": items})
}
