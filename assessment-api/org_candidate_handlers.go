package main

import (
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"assessment-api/middleware"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	amqp "github.com/rabbitmq/amqp091-go"
	"golang.org/x/crypto/bcrypt"
)

type organizationCandidateInvite struct {
	Email    string `json:"email" binding:"required,email"`
	FullName string `json:"full_name" binding:"required"`
}

func (s *Server) InviteCandidatesToOrganization(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	var req struct {
		OrgID      string                        `json:"org_id"`
		Candidates []organizationCandidateInvite `json:"candidates" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Provide at least one candidate with a valid name and email"})
		return
	}
	orgID := orgScope(c)
	if c.GetString("role") == "SUPER_ADMIN" && orgID == "" {
		orgID = strings.TrimSpace(req.OrgID)
	}
	if orgID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "An organization is required"})
		return
	}
	ctx := c.Request.Context()
	var orgName string
	if err := s.db.QueryRow(ctx, `SELECT name FROM organizations WHERE id=$1`, orgID).Scan(&orgName); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Organization not found"})
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to create organization invitations"})
		return
	}
	defer tx.Rollback(ctx)
	invites := make([]gin.H, 0, len(req.Candidates))
	type queuedInvite struct{ email, name, token string }
	queued := make([]queuedInvite, 0, len(req.Candidates))
	seenEmails := make(map[string]struct{}, len(req.Candidates))
	for _, candidate := range req.Candidates {
		email := strings.ToLower(strings.TrimSpace(candidate.Email))
		name := strings.TrimSpace(candidate.FullName)
		if email == "" || name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Candidate name and email are required"})
			return
		}
		if _, duplicate := seenEmails[email]; duplicate {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Each email may appear only once in an invitation batch"})
			return
		}
		seenEmails[email] = struct{}{}
		var alreadyRegistered bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE lower(email)=lower($1) AND role='CANDIDATE' AND registration_status='REGISTERED')`, email).Scan(&alreadyRegistered)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to verify candidate registration"})
			return
		}
		if alreadyRegistered {
			c.JSON(http.StatusConflict, gin.H{"error": "A candidate with " + email + " is already registered. Invite unregistered candidates only."})
			return
		}
		tokenBytes := make([]byte, 32)
		if _, err = crand.Read(tokenBytes); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to create secure invitation"})
			return
		}
		token := hex.EncodeToString(tokenBytes)
		var inviteID string
		err = tx.QueryRow(ctx, `
			INSERT INTO organization_candidate_invitations(org_id,email,full_name,invitation_token,status,invited_by,invited_at,expires_at,accepted_at)
			VALUES($1, $2, $3, $4, 'INVITED', NULLIF($5,'')::uuid, NOW(), NOW()+INTERVAL '7 days', NULL)
			ON CONFLICT(org_id,email) DO UPDATE SET full_name=EXCLUDED.full_name, invitation_token=EXCLUDED.invitation_token,
				status='INVITED', invited_by=EXCLUDED.invited_by, invited_at=NOW(), expires_at=NOW()+INTERVAL '7 days', accepted_at=NULL
			RETURNING id::text`, orgID, email, name, token, c.GetString("user_id")).Scan(&inviteID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to save organization invitation"})
			return
		}
		invites = append(invites, gin.H{"id": inviteID, "email": email, "full_name": name, "status": "INVITED", "expires_at": time.Now().Add(7 * 24 * time.Hour)})
		queued = append(queued, queuedInvite{email: email, name: name, token: token})
	}
	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to save organization invitations"})
		return
	}
	appURL := publicAppURL()
	queuedCount := 0
	for _, invite := range queued {
		registrationURL := appURL + "/register/" + invite.token
		payload := NotificationEventPayload{Event: "CANDIDATE_ORG_INVITE", RecipientEmail: invite.email, CandidateName: invite.name, ExamTitle: orgName, InvitationURL: registrationURL}
		body, _ := json.Marshal(payload)
		if err := s.mqChan.PublishWithContext(ctx, "", "notification_events", false, false, amqp.Publishing{ContentType: "application/json", DeliveryMode: amqp.Persistent, Body: body}); err == nil {
			queuedCount++
		}
		for _, row := range invites {
			if row["email"] == invite.email {
				row["invitation_url"] = registrationURL
				break
			}
		}
	}
	c.JSON(http.StatusCreated, gin.H{"invited": len(invites), "queued": queuedCount, "invitations": invites})
}

func (s *Server) ListCandidateOrgInvitations(c *gin.Context) {
	if !requireOrgAdmin(c) {
		return
	}
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT id::text,email,full_name,status,invited_at,expires_at
		FROM organization_candidate_invitations
		WHERE ($1='SUPER_ADMIN' OR org_id=NULLIF($2,'')::uuid)
		ORDER BY invited_at DESC`, c.GetString("role"), c.GetString("org_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load organization invitations"})
		return
	}
	defer rows.Close()
	invites := make([]gin.H, 0)
	for rows.Next() {
		var id, email, name, status string
		var invitedAt, expiresAt time.Time
		if err := rows.Scan(&id, &email, &name, &status, &invitedAt, &expiresAt); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read organization invitations"})
			return
		}
		if status == "INVITED" && time.Now().After(expiresAt) {
			status = "EXPIRED"
		}
		invites = append(invites, gin.H{"id": id, "email": email, "full_name": name, "status": status, "invited_at": invitedAt, "expires_at": expiresAt})
	}
	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read organization invitations"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"invitations": invites})
}

func (s *Server) GetCandidateOrgInvitation(c *gin.Context) {
	var invite struct {
		Email, FullName, OrgName, OrgID, Status string
		ExpiresAt                               time.Time
	}
	err := s.db.QueryRow(c.Request.Context(), `
		SELECT i.email,i.full_name,o.name,i.org_id::text,i.status,i.expires_at
		FROM organization_candidate_invitations i JOIN organizations o ON o.id=i.org_id
		WHERE i.invitation_token=$1`, c.Param("token")).Scan(&invite.Email, &invite.FullName, &invite.OrgName, &invite.OrgID, &invite.Status, &invite.ExpiresAt)
	if err != nil || invite.Status != "INVITED" || !time.Now().Before(invite.ExpiresAt) {
		c.JSON(http.StatusNotFound, gin.H{"error": "This organization invitation is invalid, expired, or already used"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"email": invite.Email, "full_name": invite.FullName, "organization": invite.OrgName, "expires_at": invite.ExpiresAt})
}

func (s *Server) RegisterInvitedCandidate(c *gin.Context) {
	var req struct {
		Password string `json:"password" binding:"required,min=10"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Choose a password with at least 10 characters"})
		return
	}
	ctx := c.Request.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to complete candidate registration"})
		return
	}
	defer tx.Rollback(ctx)
	var inviteID, orgID, email, name string
	var status string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT id::text,org_id::text,email,full_name,status,expires_at FROM organization_candidate_invitations WHERE invitation_token=$1 FOR UPDATE`, c.Param("token")).Scan(&inviteID, &orgID, &email, &name, &status, &expiresAt)
	if err != nil || status != "INVITED" || !time.Now().Before(expiresAt) {
		c.JSON(http.StatusNotFound, gin.H{"error": "This organization invitation is invalid, expired, or already used"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to secure candidate password"})
		return
	}
	var userID, userOrg, role, registrationStatus string
	err = tx.QueryRow(ctx, `SELECT id::text,COALESCE(org_id::text,''),role,registration_status FROM users WHERE lower(email)=lower($1) FOR UPDATE`, email).Scan(&userID, &userOrg, &role, &registrationStatus)
	if err == pgx.ErrNoRows {
		err = tx.QueryRow(ctx, `INSERT INTO users(org_id,email,password_hash,full_name,role,registration_status) VALUES($1,lower($2),$3,$4,'CANDIDATE','REGISTERED') RETURNING id::text`, orgID, email, string(hash), name).Scan(&userID)
	} else if err == nil {
		if role != "CANDIDATE" || (userOrg != "" && userOrg != orgID) || registrationStatus == "REGISTERED" {
			tx.Rollback(ctx)
			c.JSON(http.StatusConflict, gin.H{"error": "This email already has a registered account. Sign in or contact your organization admin."})
			return
		}
		_, err = tx.Exec(ctx, `UPDATE users SET org_id=$2,password_hash=$3,full_name=$4,registration_status='REGISTERED' WHERE id=$1`, userID, orgID, string(hash), name)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to create candidate account"})
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE organization_candidate_invitations SET status='ACCEPTED',accepted_at=NOW() WHERE id=$1`, inviteID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to accept organization invitation"})
		return
	}
	if err = tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to complete candidate registration"})
		return
	}
	token, err := middleware.GenerateToken(userID, orgID, "CANDIDATE", email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Account created but sign-in could not be started. Please sign in."})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"token": token, "user": gin.H{"id": userID, "full_name": name, "email": email, "role": "CANDIDATE", "org_id": orgID}})
}
