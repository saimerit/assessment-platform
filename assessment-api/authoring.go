package main

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type MCQOptionRequest struct {
	Text      string `json:"text" binding:"required"`
	IsCorrect bool   `json:"is_correct"`
}

type CreateQuestionRequest struct {
	SubcategoryID  string             `json:"subcategory_id"`
	BankID         string             `json:"bank_id"`
	QuestionType   string             `json:"question_type"`
	Title          string             `json:"title" binding:"required"`
	Statement      string             `json:"statement" binding:"required"`
	Difficulty     string             `json:"difficulty" binding:"required"`
	Marks          int                `json:"marks" binding:"required"`
	Options        []MCQOptionRequest `json:"options"`
	ExpectedAnswer string             `json:"expected_answer"`
}

type CreateQuestionsBulkRequest struct {
	BankID   string                 `json:"bank_id" binding:"required"`
	Questions []CreateQuestionRequest `json:"questions" binding:"required,min=1,max=50,dive"`
}

type BlueprintRuleRequest struct {
	TopicID       string `json:"topic_id" binding:"required"`
	Difficulty    string `json:"difficulty" binding:"required"`
	QuestionCount int    `json:"question_count" binding:"required"`
}

type CreateBlueprintRequest struct {
	Title           string                 `json:"title" binding:"required"`
	DurationMinutes int                    `json:"duration_minutes" binding:"required"`
	TotalMarks      int                    `json:"total_marks" binding:"required"`
	MinVersion      string                 `json:"min_client_version"`
	Rules           []BlueprintRuleRequest `json:"rules" binding:"required,min=1,dive"`
}

var semanticVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func normalizeDifficulty(value string) (string, bool) {
	difficulty := strings.ToUpper(strings.TrimSpace(value))
	switch difficulty {
	case "EASY", "MEDIUM", "HARD":
		return difficulty, true
	default:
		return "", false
	}
}

// CreateQuestion writes the question and its MCQ options atomically.
func (s *Server) CreateQuestion(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	var req CreateQuestionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	req.Title = strings.TrimSpace(req.Title)
	req.Statement = strings.TrimSpace(req.Statement)
	if req.Title == "" || req.Statement == "" || req.Marks <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title, statement, and positive marks are required"})
		return
	}
	difficulty, ok := normalizeDifficulty(req.Difficulty)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "difficulty must be EASY, MEDIUM, or HARD"})
		return
	}
	qType := strings.ToUpper(strings.TrimSpace(req.QuestionType))
	if qType == "" {
		qType = "MCQ"
	}
	if qType != "MCQ" && qType != "FIB" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question_type must be MCQ or FIB"})
		return
	}
	correctCount := 0
	for i := range req.Options {
		req.Options[i].Text = strings.TrimSpace(req.Options[i].Text)
		if req.Options[i].Text == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "option text cannot be empty"})
			return
		}
		if req.Options[i].IsCorrect {
			correctCount++
		}
	}
	if qType == "MCQ" && (len(req.Options) < 3 || len(req.Options) > 7 || correctCount < 1) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "MCQ questions require 3 to 7 options and at least one correct option"})
		return
	}
	if qType == "FIB" && strings.TrimSpace(req.ExpectedAnswer) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "FIB questions require expected_answer"})
		return
	}

	orgID := c.GetString("org_id")
	var subcategoryVisible bool
	if req.SubcategoryID != "" {
		err := s.db.QueryRow(c.Request.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM subcategories sc
			JOIN topics t ON t.id = sc.topic_id
			WHERE sc.id = $1
			  AND (t.org_id IS NULL OR t.org_id = NULLIF($2, '')::uuid)
		)`, req.SubcategoryID, orgID).Scan(&subcategoryVisible)
		if err != nil || !subcategoryVisible {
			c.JSON(http.StatusBadRequest, gin.H{"error": "subcategory not found or outside your organization"})
			return
		}
	}
	if req.BankID != "" {
		var bankVisible bool
		if err := s.db.QueryRow(c.Request.Context(), `SELECT EXISTS (SELECT 1 FROM question_banks WHERE id=$1 AND ($2='' OR org_id=NULLIF($2,'')::uuid))`, req.BankID, orgID).Scan(&bankVisible); err != nil || !bankVisible {
			c.JSON(http.StatusBadRequest, gin.H{"error": "question bank not found or outside your organization"})
			return
		}
	}
	if req.SubcategoryID == "" && req.BankID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bank_id or subcategory_id is required"})
		return
	}

	tx, err := s.db.Begin(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to start question transaction"})
		return
	}
	defer tx.Rollback(c.Request.Context())

	var questionID string
	var subcategory any
	if req.SubcategoryID != "" {
		subcategory = req.SubcategoryID
	}
	var bank any
	if req.BankID != "" {
		bank = req.BankID
	}
	err = tx.QueryRow(c.Request.Context(), `
		INSERT INTO questions (subcategory_id, bank_id, q_type, title, statement, difficulty, marks, question_type)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $3) RETURNING id::text`,
		subcategory, bank, qType, req.Title, req.Statement, difficulty, req.Marks).Scan(&questionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create question"})
		return
	}
	var correctOptionIDs []string
	for i, option := range req.Options {
		var optionID string
		if err = tx.QueryRow(c.Request.Context(), `
			INSERT INTO mcq_options (question_id, option_text, display_order)
			VALUES ($1, $2, $3) RETURNING id::text`, questionID, option.Text, i+1).Scan(&optionID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create question options"})
			return
		}
		if option.IsCorrect {
			correctOptionIDs = append(correctOptionIDs, optionID)
		}
	}
	if qType == "MCQ" {
		_, err = tx.Exec(c.Request.Context(), `INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_option_id,expected_option_ids) VALUES($1,'MCQ',$2,ARRAY(SELECT unnest($3::text[])::uuid))`, questionID, correctOptionIDs[0], correctOptionIDs)
	} else {
		_, err = tx.Exec(c.Request.Context(), `INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_text) VALUES($1,'FIB',$2)`, questionID, strings.TrimSpace(req.ExpectedAnswer))
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save answer key"})
		return
	}
	if err = tx.Commit(c.Request.Context()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save question"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "Question authored successfully", "question_id": questionID})
}

// CreateQuestionsBulk saves a bank's question batch atomically, including each
// question's options and its grading-only answer key.
func (s *Server) CreateQuestionsBulk(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	var req CreateQuestionsBulkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	orgID := c.GetString("org_id")
	var bankVisible bool
	if err := s.db.QueryRow(c.Request.Context(), `SELECT EXISTS (SELECT 1 FROM question_banks WHERE id=$1 AND ($2='' OR org_id=NULLIF($2,'')::uuid))`, req.BankID, orgID).Scan(&bankVisible); err != nil || !bankVisible {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question bank not found or outside your organization"})
		return
	}
	for i := range req.Questions {
		q := &req.Questions[i]
		q.BankID = req.BankID
		q.Title = strings.TrimSpace(q.Title)
		q.Statement = strings.TrimSpace(q.Statement)
		if q.Title == "" || q.Statement == "" || q.Marks <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "each question requires a title, prompt, and positive marks"})
			return
		}
		if _, ok := normalizeDifficulty(q.Difficulty); !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "difficulty must be EASY, MEDIUM, or HARD"})
			return
		}
		q.QuestionType = strings.ToUpper(strings.TrimSpace(q.QuestionType))
		if q.QuestionType == "" {
			q.QuestionType = "MCQ"
		}
		if q.QuestionType != "MCQ" && q.QuestionType != "FIB" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "question_type must be MCQ or FIB"})
			return
		}
		correctCount := 0
		for j := range q.Options {
			q.Options[j].Text = strings.TrimSpace(q.Options[j].Text)
			if q.Options[j].Text == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "option text cannot be empty"})
				return
			}
			if q.Options[j].IsCorrect {
				correctCount++
			}
		}
		if q.QuestionType == "MCQ" && (len(q.Options) < 3 || len(q.Options) > 7 || correctCount == 0) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "each multiple choice question requires 3 to 7 options and at least one correct option"})
			return
		}
		if q.QuestionType == "FIB" && strings.TrimSpace(q.ExpectedAnswer) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "fill-in-the-blank questions require an expected answer"})
			return
		}
		q.Difficulty, _ = normalizeDifficulty(q.Difficulty)
	}

	tx, err := s.db.Begin(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to start question transaction"})
		return
	}
	defer tx.Rollback(c.Request.Context())
	ids := make([]string, 0, len(req.Questions))
	for _, question := range req.Questions {
		id, err := insertQuestion(c.Request.Context(), tx, question)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to save the question batch"})
			return
		}
		ids = append(ids, id)
	}
	if err := tx.Commit(c.Request.Context()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to save the question batch"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "Question batch created successfully", "question_ids": ids, "created_count": len(ids)})
}

func insertQuestion(ctx context.Context, tx pgx.Tx, req CreateQuestionRequest) (string, error) {
	var questionID string
	err := tx.QueryRow(ctx, `INSERT INTO questions (subcategory_id, bank_id, q_type, title, statement, difficulty, marks, question_type) VALUES (NULLIF($1,'')::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6, $7, $3) RETURNING id::text`, req.SubcategoryID, req.BankID, req.QuestionType, req.Title, req.Statement, req.Difficulty, req.Marks).Scan(&questionID)
	if err != nil {
		return "", err
	}
	correctOptionIDs := make([]string, 0)
	for index, option := range req.Options {
		var optionID string
		if err := tx.QueryRow(ctx, `INSERT INTO mcq_options (question_id, option_text, display_order) VALUES ($1,$2,$3) RETURNING id::text`, questionID, option.Text, index+1).Scan(&optionID); err != nil {
			return "", err
		}
		if option.IsCorrect {
			correctOptionIDs = append(correctOptionIDs, optionID)
		}
	}
	if req.QuestionType == "MCQ" {
		_, err = tx.Exec(ctx, `INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_option_id,expected_option_ids) VALUES($1,'MCQ',$2,ARRAY(SELECT unnest($3::text[])::uuid))`, questionID, correctOptionIDs[0], correctOptionIDs)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_text) VALUES($1,'FIB',$2)`, questionID, strings.TrimSpace(req.ExpectedAnswer))
	}
	if err != nil {
		return "", err
	}
	return questionID, nil
}

// CreateBlueprint writes a blueprint and its randomized question selection rules atomically.
func (s *Server) CreateBlueprint(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	var req CreateBlueprintRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || req.DurationMinutes <= 0 || req.TotalMarks <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title, positive duration, and positive total marks are required"})
		return
	}
	minVersion := strings.TrimSpace(req.MinVersion)
	if minVersion == "" {
		minVersion = "1.0.0"
	}
	if !semanticVersionPattern.MatchString(minVersion) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "min_client_version must use MAJOR.MINOR.PATCH format"})
		return
	}
	orgID := c.GetString("org_id")
	for i := range req.Rules {
		difficulty, ok := normalizeDifficulty(req.Rules[i].Difficulty)
		if !ok || req.Rules[i].QuestionCount <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "each rule needs EASY, MEDIUM, or HARD difficulty and a positive question_count"})
			return
		}
		req.Rules[i].Difficulty = difficulty
		var topicVisible bool
		if err := s.db.QueryRow(c.Request.Context(), `
			SELECT EXISTS (
				SELECT 1 FROM topics
				WHERE id = $1 AND (org_id IS NULL OR org_id = NULLIF($2, '')::uuid)
			)`, req.Rules[i].TopicID, orgID).Scan(&topicVisible); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to validate blueprint topic"})
			return
		}
		if !topicVisible {
			c.JSON(http.StatusBadRequest, gin.H{"error": "blueprint topic not found or outside your organization"})
			return
		}
	}

	tx, err := s.db.Begin(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to start blueprint transaction"})
		return
	}
	defer tx.Rollback(c.Request.Context())

	var orgValue any
	if orgID != "" {
		orgValue = orgID
	}
	var blueprintID string
	err = tx.QueryRow(c.Request.Context(), `
		INSERT INTO assessment_blueprints (org_id, title, duration_minutes, total_marks, min_client_version)
		VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
		orgValue, req.Title, req.DurationMinutes, req.TotalMarks, minVersion).Scan(&blueprintID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create blueprint"})
		return
	}
	for _, rule := range req.Rules {
		if _, err = tx.Exec(c.Request.Context(), `
			INSERT INTO blueprint_rules (blueprint_id, topic_id, difficulty, question_count)
			VALUES ($1, $2, $3, $4)`, blueprintID, rule.TopicID, rule.Difficulty, rule.QuestionCount); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create blueprint rules"})
			return
		}
	}
	if err = tx.Commit(c.Request.Context()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save blueprint"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "Assessment blueprint configured successfully", "blueprint_id": blueprintID})
}

// GetClientVersion exposes the latest published desktop client release to the gateway.
func (s *Server) GetClientVersion(c *gin.Context) {
	var release struct {
		Version      string `json:"version"`
		DownloadURL  string `json:"download_url"`
		ReleaseNotes string `json:"release_notes"`
		IsMandatory  bool   `json:"is_mandatory"`
	}
	err := s.db.QueryRow(c.Request.Context(), `
		SELECT version, download_url, COALESCE(release_notes, ''), is_mandatory
		FROM client_releases ORDER BY released_at DESC LIMIT 1`).Scan(
		&release.Version, &release.DownloadURL, &release.ReleaseNotes, &release.IsMandatory)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No desktop client release is available"})
		return
	}
	c.JSON(http.StatusOK, release)
}
