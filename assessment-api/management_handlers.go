package main

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func (s *Server) ListAdminCandidates(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `
		SELECT u.id::text,u.full_name,u.email,u.created_at,
		       (SELECT COUNT(*) FROM assessment_invitations i WHERE i.student_id=u.id),
	       (SELECT COUNT(*) FROM candidate_sessions cs WHERE cs.student_id=u.id)
		FROM users u
		WHERE u.role='CANDIDATE'
		  AND u.registration_status='REGISTERED'
		  AND ($1='SUPER_ADMIN' OR u.org_id=NULLIF($2,'')::uuid)
		ORDER BY u.full_name,u.email`, c.GetString("role"), c.GetString("org_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load candidate accounts"})
		return
	}
	defer rows.Close()
	candidates := make([]gin.H, 0)
	for rows.Next() {
		var id, name, email string
		var created time.Time
		var blueprintInvites, eventInvites int
		if err := rows.Scan(&id, &name, &email, &created, &blueprintInvites, &eventInvites); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read candidate accounts"})
			return
		}
		candidates = append(candidates, gin.H{"id": id, "full_name": name, "email": email, "created_at": created, "blueprint_invitations": blueprintInvites, "event_invitations": eventInvites})
	}
	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read candidate accounts"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"candidates": candidates})
}

func (s *Server) ListAdminResults(c *gin.Context) {
	rows, err := s.db.Query(c.Request.Context(), `
		WITH graded_results AS (
			SELECT cai.student_id::text AS candidate_id, cai.blueprint_id::text AS assessment_id,
			       'BLUEPRINT'::text AS assessment_type, u.full_name,u.email,b.title AS assessment_title,
			       cr.total_score AS score,cr.max_score,cr.evaluated_at
			FROM candidate_results cr
			JOIN candidate_assessment_instances cai ON cai.id=cr.instance_id
			JOIN users u ON u.id=cai.student_id
			JOIN assessment_blueprints b ON b.id=cai.blueprint_id
			WHERE ($1='SUPER_ADMIN' OR b.org_id=NULLIF($2,'')::uuid)
			  AND ($1='SUPER_ADMIN' OR u.org_id=NULLIF($2,'')::uuid)
			UNION ALL
			SELECT cs.student_id::text AS candidate_id, cs.assessment_id::text AS assessment_id,
			       'EVENT'::text AS assessment_type, u.full_name,u.email,e.title AS assessment_title,
			       csr.score_obtained AS score,csr.max_score,csr.evaluated_at
			FROM candidate_session_results csr
			JOIN candidate_sessions cs ON cs.id=csr.session_id
			JOIN assessment_events e ON e.id=cs.assessment_id
			JOIN users u ON u.id=cs.student_id
			WHERE ($1='SUPER_ADMIN' OR e.org_id=NULLIF($2,'')::uuid)
			  AND ($1='SUPER_ADMIN' OR u.org_id=NULLIF($2,'')::uuid)
		)
		SELECT candidate_id,assessment_id,assessment_type,full_name,email,assessment_title,score,max_score,evaluated_at
		FROM graded_results
		WHERE ($3='' OR assessment_id=$3)
		  AND ($4='' OR candidate_id=$4)
		ORDER BY evaluated_at DESC`, c.GetString("role"), c.GetString("org_id"), c.Query("assessment_id"), c.Query("candidate_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to load assessment results"})
		return
	}
	defer rows.Close()
	results := make([]gin.H, 0)
	for rows.Next() {
		var candidateID, assessmentID, assessmentType, name, email, title string
		var score, max float64
		var evaluated time.Time
		if err := rows.Scan(&candidateID, &assessmentID, &assessmentType, &name, &email, &title, &score, &max, &evaluated); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read assessment results"})
			return
		}
		results = append(results, gin.H{"candidate_id": candidateID, "assessment_id": assessmentID, "assessment_type": assessmentType, "candidate_name": name, "email": email, "assessment_title": title, "score": score, "max_score": max, "evaluated_at": evaluated})
	}
	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read assessment results"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"results": results})
}
