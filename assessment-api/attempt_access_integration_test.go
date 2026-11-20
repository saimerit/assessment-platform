package main

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"assessment-api/middleware"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

// Run against the actual migrations in disposable PostgreSQL/Redis containers
// with scripts/test-attempt-access.ps1, never against the platform database.
func TestAttemptAccessIntegration(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("run scripts/test-attempt-access.ps1 for isolated integration tests")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil || parsed.Path != "/assessment_attempt_auth_test" {
		t.Fatal("integration tests require the isolated assessment_attempt_auth_test database")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	redisOptions, err := redis.ParseURL(os.Getenv("TEST_REDIS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(redisOptions)
	defer rdb.Close()
	s, _ := accessFixture(t, attemptSession, false)
	s.db, s.rdb = db, rdb
	s.attempts.repository = postgresAttemptRepository{db}
	s.limits = redisRequestLimitStore{rdb}
	newID := func(query string, args ...any) string {
		t.Helper()
		var id string
		if err := db.QueryRow(ctx, query+" RETURNING id::text", args...).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	org := newID(`INSERT INTO organizations(name,domain) VALUES('Attempt access test','attempt-access.test')`)
	otherOrg := newID(`INSERT INTO organizations(name,domain) VALUES('Other access test','other-attempt-access.test')`)
	t.Cleanup(func() {
		if os.Getenv("TEST_REVIEW_MANIFEST") != "" {
			return
		}
		_, _ = db.Exec(ctx, `DELETE FROM organizations WHERE id=ANY($1::uuid[])`, []string{org, otherOrg})
	})
	hash, err := bcrypt.GenerateFromPassword([]byte("TestPassword123!"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	user := func(email, organization string) string {
		return newID(`INSERT INTO users(org_id,email,password_hash,full_name,role,registration_status) VALUES($1,$2,$3,'Test candidate','CANDIDATE','REGISTERED')`, organization, email, string(hash))
	}
	candidate := user("assigned@attempt-access.test", org)
	otherCandidate := user("other@attempt-access.test", org)
	foreignCandidate := user("foreign@attempt-access.test", otherOrg)
	bank := newID(`INSERT INTO question_banks(org_id,name) VALUES($1,'Access test bank')`, org)
	question := newID(`INSERT INTO questions(bank_id,title,statement,q_type) VALUES($1,'Text response','Describe an answer','FIB')`, bank)
	mcq := newID(`INSERT INTO questions(bank_id,title,statement,q_type) VALUES($1,'Choose options','Choose valid options','MCQ')`, bank)
	newID(`INSERT INTO mcq_options(question_id,option_text,display_order) VALUES($1,'Option one',1)`, mcq)
	newID(`INSERT INTO mcq_options(question_id,option_text,display_order) VALUES($1,'Option two',2)`, mcq)
	exec(`INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_text) VALUES($1,'FIB','response')`, question)
	exec(`INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_option_id,expected_option_ids) SELECT $1,'MCQ',id,ARRAY[id] FROM mcq_options WHERE question_id=$1 ORDER BY display_order LIMIT 1`, mcq)
	event := newID(`INSERT INTO assessment_events(org_id,title,mode,scheduled_start,scheduled_end,duration_minutes) VALUES($1,'Access test','OFFLINE_NORMAL',NOW()-interval '5 minutes',NOW()+interval '90 minutes',60)`, org)
	paper := newID(`INSERT INTO assessment_papers(assessment_id,paper_code,set_name) VALUES($1,'ACCESS-1','SET-A')`, event)
	exec(`INSERT INTO paper_questions(paper_id,question_id,sort_order) VALUES($1,$2,1),($1,$3,2)`, paper, question, mcq)
	session := newID(`INSERT INTO candidate_sessions(assessment_id,paper_id,student_id,invitation_token) VALUES($1,$2,$3,'test-event-invitation')`, event, paper, candidate)
	otherSession := newID(`INSERT INTO candidate_sessions(assessment_id,paper_id,student_id,invitation_token) VALUES($1,$2,$3,'other-event-invitation')`, event, paper, otherCandidate)
	blueprint := newID(`INSERT INTO assessment_blueprints(org_id,title) VALUES($1,'Legacy access test')`, org)
	newID(`INSERT INTO assessment_invitations(blueprint_id,student_id,invitation_token,scheduled_start,scheduled_end,passcode_hash) VALUES($1,$2,'test-legacy-invitation',NOW()-interval '5 minutes',NOW()+interval '90 minutes',$3)`, blueprint, candidate, string(hash))
	// Simulate an instance created through the old bypass; it must unlock now.
	instance := newID(`INSERT INTO candidate_assessment_instances(blueprint_id,student_id,status) VALUES($1,$2,'IN_PROGRESS')`, blueprint, candidate)
	exec(`INSERT INTO instance_questions(instance_id,question_id,display_order) VALUES($1,$2,1),($1,$3,2)`, instance, question, mcq)
	if err := rdb.Set(ctx, "event_passcode:"+event, "123456", time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	if err := rdb.Set(ctx, "passcode:"+blueprint+":"+candidate, "654321", time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	_ = r.SetTrustedProxies(nil)
	s.registerAttemptRoutes(r)
	r.POST("/api/auth/login", limitRequestBody(4096), s.limitLoginIP, s.handleLogin)
	login := testRequest(t, r, "POST", "/api/auth/login", "", `{"email":"assigned@attempt-access.test","password":"TestPassword123!"}`, 200)
	var identity struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &identity); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{otherCandidate, foreignCandidate} {
		orgID := org
		if id == foreignCandidate {
			orgID = otherOrg
		}
		token, _ := middleware.GenerateToken(id, orgID, "CANDIDATE", "other@attempt-access.test")
		testRequest(t, r, "POST", "/api/exam/access", token, `{"invitation_token":"test-event-invitation"}`, 403)
	}
	checkIn := responseToken(t, testRequest(t, r, "POST", "/api/exam/access", identity.Token, `{"invitation_token":"test-event-invitation"}`, 200))
	sessionPath := "/api/exam/sessions/" + session
	testRequest(t, r, "POST", sessionPath+"/start", checkIn, `{}`, 403)
	testRequest(t, r, "GET", sessionPath+"/questions", checkIn, ``, 403)
	testRequest(t, r, "POST", sessionPath+"/unlock", checkIn, `{"passcode":"incorrect"}`, 403)
	var unlockedAt *time.Time
	if err := db.QueryRow(ctx, `SELECT unlocked_at FROM candidate_sessions WHERE id=$1`, session).Scan(&unlockedAt); err != nil || unlockedAt != nil {
		t.Fatal("invalid code unlocked the session", err)
	}
	active := responseToken(t, testRequest(t, r, "POST", sessionPath+"/unlock", checkIn, `{"passcode":"123456"}`, 200))
	firstStart := testRequest(t, r, "POST", sessionPath+"/start", active, `{}`, 200)
	secondStart := testRequest(t, r, "POST", sessionPath+"/start", active, `{}`, 200)
	var firstTimer, secondTimer map[string]any
	if err := json.Unmarshal(firstStart.Body.Bytes(), &firstTimer); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(secondStart.Body.Bytes(), &secondTimer); err != nil {
		t.Fatal(err)
	}
	if firstTimer["started_at"] != secondTimer["started_at"] || firstTimer["timer_expires_at"] != secondTimer["timer_expires_at"] {
		t.Fatalf("repeated start changed timer: first=%v second=%v", firstTimer, secondTimer)
	}
	testRequest(t, r, "GET", sessionPath+"/questions", active, ``, 200)
	proctor := user("proctor@attempt-access.test", org)
	exec(`UPDATE users SET role='INVIGILATOR_PROCTOR' WHERE id=$1`, proctor)
	exec(`INSERT INTO assessment_proctors(assessment_id,proctor_id,passcode_hash) VALUES($1,$2,$3)`, event, proctor, string(hash))
	if err := rdb.Set(ctx, "event_proctor_passcode:"+event+":"+proctor, "222222", time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE assessment_events SET mode='ONLINE_PROCTORING' WHERE id=$1`, event)
	testRequest(t, r, "POST", sessionPath+"/unlock", active, `{"passcode":"222222","camera_ready":false,"microphone_ready":false}`, 403)
	testRequest(t, r, "POST", sessionPath+"/unlock", active, `{"passcode":"222222","camera_ready":true,"microphone_ready":true}`, 200)
	exec(`UPDATE assessment_events SET mode='OFFLINE_PROCTORING' WHERE id=$1`, event)
	testRequest(t, r, "POST", sessionPath+"/unlock", active, `{"passcode":"222222"}`, 200)
	// Five unlock requests have used this candidate's minute budget.
	for range 5 {
		testRequest(t, r, "POST", sessionPath+"/unlock", active, `{"passcode":"222222"}`, 200)
	}
	testRequest(t, r, "POST", sessionPath+"/unlock", active, `{"passcode":"222222"}`, 429)
	testRequest(t, r, "GET", "/api/exam/sessions/"+otherSession+"/questions", active, ``, 403)
	testRequest(t, r, "POST", "/api/assessments/"+blueprint+"/start", active, `{}`, 403)
	testRequest(t, r, "POST", "/api/proctor/incidents", active, `{"student_id":"`+otherCandidate+`","violation_type":"FOCUS"}`, 403)
	testRequest(t, r, "POST", "/api/proctor/incidents", active, `{"reported_by":"ORG_ADMIN","violation_type":"FOCUS"}`, 201)
	var reporter, student string
	if err := db.QueryRow(ctx, `SELECT reported_by,student_id::text FROM assessment_event_incidents WHERE assessment_id=$1`, event).Scan(&reporter, &student); err != nil || reporter != "ELECTRON_LOCKDOWN_CLIENT" || student != candidate {
		t.Fatal("incident identity was not server-bound", err)
	}
	// Renewal uses the persisted unlock state and survives a new client instance.
	renewed := responseToken(t, testRequest(t, r, "POST", "/api/exam/access", identity.Token, `{"invitation_token":"test-event-invitation"}`, 200))
	testRequest(t, r, "GET", sessionPath+"/questions", renewed, ``, 200)
	exec(`UPDATE users SET role='INVIGILATOR_PROCTOR' WHERE id=$1`, candidate)
	testRequest(t, r, "GET", sessionPath+"/questions", active, ``, 403)
	exec(`UPDATE users SET role='CANDIDATE' WHERE id=$1`, candidate)
	exec(`UPDATE candidate_sessions SET status='EXPIRED' WHERE id=$1`, session)
	testRequest(t, r, "GET", sessionPath+"/questions", active, ``, 403)
	legacyCheckIn := responseToken(t, testRequest(t, r, "POST", "/api/exam/access", identity.Token, `{"invitation_token":"test-legacy-invitation"}`, 200))
	legacyPath := "/api/assessments/" + blueprint
	testRequest(t, r, "POST", legacyPath+"/start", legacyCheckIn, `{"student_id":"`+candidate+`"}`, 403)
	legacyActive := responseToken(t, testRequest(t, r, "POST", legacyPath+"/verify-passcode", legacyCheckIn, `{"passcode":"654321"}`, 200))
	testRequest(t, r, "POST", legacyPath+"/start", legacyActive, `{"student_id":"`+candidate+`"}`, 200)
	testRequest(t, r, "POST", "/api/proctor/incidents", legacyActive, `{"violation_type":"FOCUS"}`, 201)
	// Concurrent rate limiting uses one atomic counter across API instances.
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, ttl, err := s.limits.Take(ctx, "integration-limit", 10, time.Minute)
			if err != nil || ttl <= 0 {
				t.Error("invalid Redis rate limit", err)
			}
			if ok {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 10 {
		t.Fatalf("rate limiter allowed %d of 40; want 10", allowed.Load())
	}
	if manifestPath := os.Getenv("TEST_REVIEW_MANIFEST"); manifestPath != "" {
		// Preserve the same exercised fixtures for a human UI review, restoring
		// their entry state and clearing only this disposable Redis database.
		exec(`UPDATE assessment_events SET mode='OFFLINE_NORMAL',scheduled_start=NOW()-interval '5 minutes',scheduled_end=NOW()+interval '4 hours' WHERE id=$1`, event)
		exec(`UPDATE candidate_sessions SET status='INVITED',started_at=NULL,unlocked_at=NULL WHERE assessment_id=$1`, event)
		exec(`UPDATE assessment_invitations SET unlocked_at=NULL,scheduled_start=NOW()-interval '5 minutes',scheduled_end=NOW()+interval '4 hours' WHERE blueprint_id=$1`, blueprint)
		if err := rdb.FlushDB(ctx).Err(); err != nil {
			t.Fatal(err)
		}
		if err := rdb.Set(ctx, "event_passcode:"+event, "123456", 4*time.Hour).Err(); err != nil {
			t.Fatal(err)
		}
		if err := rdb.Set(ctx, "passcode:"+blueprint+":"+candidate, "654321", 4*time.Hour).Err(); err != nil {
			t.Fatal(err)
		}
		manifest := map[string]any{
			"candidate_a": "assigned@attempt-access.test", "candidate_b": "other@attempt-access.test",
			"candidate_c": "foreign@attempt-access.test", "staff": "proctor@attempt-access.test",
			"password": "TestPassword123!", "event_code": "123456", "legacy_code": "654321",
			"event_invitation": "test-event-invitation", "other_invitation": "other-event-invitation",
			"legacy_invitation": "test-legacy-invitation", "event_id": event, "session_id": session,
			"other_session_id": otherSession, "candidate_id": candidate, "blueprint_id": blueprint,
		}
		body, err := json.MarshalIndent(manifest, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manifestPath, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
