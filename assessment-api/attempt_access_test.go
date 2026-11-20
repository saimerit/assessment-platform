package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"assessment-api/middleware"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

type memoryAttemptRepository struct {
	record attemptRecord
	err    error
}

func (r *memoryAttemptRepository) FindInvitation(context.Context, string) (attemptRecord, error) {
	return r.record, r.err
}
func (r *memoryAttemptRepository) FindAttempt(context.Context, string, string) (attemptRecord, error) {
	return r.record, r.err
}

type memoryRequestLimits struct {
	counts map[string]int
	err    error
}

func (m *memoryRequestLimits) Take(_ context.Context, key string, maximum int, window time.Duration) (bool, time.Duration, error) {
	if m.counts == nil {
		m.counts = map[string]int{}
	}
	m.counts[key]++
	return m.counts[key] <= maximum, window, m.err
}

func accessFixture(t *testing.T, kind string, unlocked bool) (*Server, *memoryAttemptRepository) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	now := time.Now().UTC().Truncate(time.Second)
	r := &memoryAttemptRepository{record: attemptRecord{ID: "attempt-a", Kind: kind,
		AssessmentID: "assessment-a", StudentID: "candidate-a", OrgID: "org-a", Status: "INVITED",
		CandidateRole: "CANDIDATE", CandidateOrgID: "org-a", RegistrationStatus: "REGISTERED"}}
	if unlocked {
		r.record.UnlockedAt = &now
		r.record.Status = "IN_PROGRESS"
	}
	secret := []byte("test-only-secret-with-at-least-32-characters")
	previous := middleware.JWTSecret
	middleware.JWTSecret = secret
	t.Cleanup(func() { middleware.JWTSecret = previous })
	return &Server{attempts: &attemptAccessService{repository: r, secret: secret, now: func() time.Time { return now }}, limits: &memoryRequestLimits{}}, r
}

func testRequest(t *testing.T, r http.Handler, method, path, token, body string, want int) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != want {
		t.Fatalf("%s %s: got %d, want %d: %s", method, path, w.Code, want, w.Body.String())
	}
	return w
}

func issuedToken(t *testing.T, s *Server, a attemptRecord) string {
	t.Helper()
	token, _, err := s.attempts.issue(a)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func responseToken(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Token string `json:"attempt_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Token == "" {
		t.Fatalf("missing attempt credential: %s", w.Body.String())
	}
	return body.Token
}

func TestAllExecutionRoutesRequireAttemptCredentials(t *testing.T) {
	s, _ := accessFixture(t, attemptSession, false)
	r := gin.New()
	s.registerAttemptRoutes(r)
	account, _ := middleware.GenerateToken("candidate-a", "org-a", "CANDIDATE", "a@example.com")
	for _, token := range []string{"", "invitation-token", account} {
		for _, route := range []struct{ method, path string }{
			{"GET", "/api/exam/sessions/attempt-a/questions"}, {"POST", "/api/exam/sessions/attempt-a/unlock"},
			{"POST", "/api/exam/sessions/attempt-a/start"}, {"POST", "/api/exam/sessions/attempt-a/submit"},
			{"POST", "/api/assessments/assessment-a/verify-passcode"}, {"POST", "/api/assessments/assessment-a/start"},
			{"POST", "/api/assessments/assessment-a/submit"}, {"POST", "/api/proctor/incidents"},
		} {
			testRequest(t, r, route.method, route.path, token, `{}`, 401)
		}
	}
}

func TestAttemptScopesAndLiveAssignment(t *testing.T) {
	for _, kind := range []string{attemptSession, attemptLegacy} {
		t.Run(kind, func(t *testing.T) {
			for _, tc := range []struct {
				name   string
				mutate func(*attemptRecord)
			}{
				{"different candidate", func(a *attemptRecord) { a.StudentID = "candidate-b" }},
				{"different organization", func(a *attemptRecord) { a.OrgID = "org-b" }},
				{"different assessment", func(a *attemptRecord) { a.AssessmentID = "assessment-b" }},
				{"membership changed", func(a *attemptRecord) { a.CandidateOrgID = "org-b" }},
				{"role changed", func(a *attemptRecord) { a.CandidateRole = "ORG_ADMIN" }},
				{"registration revoked", func(a *attemptRecord) { a.RegistrationStatus = "INVITED" }},
				{"unlock revoked", func(a *attemptRecord) { a.UnlockedAt = nil }},
				{"submitted", func(a *attemptRecord) { a.Status = "SUBMITTED" }},
				{"evaluated", func(a *attemptRecord) { a.Status = "EVALUATED" }},
				{"expired", func(a *attemptRecord) { a.Status = "EXPIRED" }},
			} {
				t.Run(tc.name, func(t *testing.T) {
					s, repo := accessFixture(t, kind, true)
					token := issuedToken(t, s, repo.record)
					tc.mutate(&repo.record)
					r := gin.New()
					path := "/attempt/:session_id"
					target := "/attempt/attempt-a"
					if kind == attemptLegacy {
						path = "/attempt/:id"
						target = "/attempt/assessment-a"
					}
					r.POST(path, s.attempts.require(kind, "start"), func(c *gin.Context) { c.Status(204) })
					testRequest(t, r, "POST", target, token, `{}`, 403)
				})
			}
			s, repo := accessFixture(t, kind, true)
			r := gin.New()
			if kind == attemptSession {
				r.POST("/attempt/:session_id", s.attempts.require(kind, "start"), func(c *gin.Context) { c.Status(204) })
			} else {
				r.POST("/attempt/:id", s.attempts.require(kind, "start"), func(c *gin.Context) { c.Status(204) })
			}
			testRequest(t, r, "POST", "/attempt/other-attempt", issuedToken(t, s, repo.record), `{}`, 403)
		})
	}
}

func TestUnlockIsRequiredForExecution(t *testing.T) {
	for _, kind := range []string{attemptSession, attemptLegacy} {
		s, repo := accessFixture(t, kind, false)
		token := issuedToken(t, s, repo.record)
		for _, op := range []string{"start", "questions", "submit", "incident"} {
			r := gin.New()
			r.POST("/attempt", s.attempts.require("", op), func(c *gin.Context) { c.Status(204) })
			testRequest(t, r, "POST", "/attempt", token, `{}`, 403)
		}
		r := gin.New()
		r.POST("/attempt", s.attempts.require("", "unlock"), func(c *gin.Context) { c.Status(204) })
		testRequest(t, r, "POST", "/attempt", token, `{}`, 204)
	}
}

func TestAttemptJWTBoundariesAndTokenSeparation(t *testing.T) {
	s, repo := accessFixture(t, attemptSession, true)
	token := issuedToken(t, s, repo.record)
	issued := s.attempts.now()
	s.attempts.now = func() time.Time { return issued.Add(attemptTokenLifetime - time.Second) }
	if _, err := s.attempts.parse("Bearer " + token); err != nil {
		t.Fatal(err)
	}
	s.attempts.now = func() time.Time { return issued.Add(attemptTokenLifetime) }
	if _, err := s.attempts.parse("Bearer " + token); err == nil {
		t.Fatal("token accepted at expiration")
	}
	s.attempts.now = func() time.Time { return issued }
	claims, err := s.attempts.parse("Bearer " + token)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*attemptClaims)
		method jwt.SigningMethod
		key    []byte
	}{
		{"issuer", func(c *attemptClaims) { c.Issuer = "other" }, jwt.SigningMethodHS256, s.attempts.secret},
		{"audience", func(c *attemptClaims) { c.Audience = jwt.ClaimStrings{"portal"} }, jwt.SigningMethodHS256, s.attempts.secret},
		{"missing expiry", func(c *attemptClaims) { c.ExpiresAt = nil }, jwt.SigningMethodHS256, s.attempts.secret},
		{"wrong algorithm", func(*attemptClaims) {}, jwt.SigningMethodHS384, s.attempts.secret},
		{"wrong signature", func(*attemptClaims) {}, jwt.SigningMethodHS256, []byte("a-different-signing-secret")},
	} {
		copyClaims := *claims
		tc.change(&copyClaims)
		bad, err := jwt.NewWithClaims(tc.method, copyClaims).SignedString(tc.key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.attempts.parse("Bearer " + bad); err == nil {
			t.Errorf("accepted %s", tc.name)
		}
	}
	r := gin.New()
	r.GET("/portal", middleware.AuthMiddleware(), func(c *gin.Context) { c.Status(204) })
	testRequest(t, r, "GET", "/portal", token, ``, 401)
}

func TestInvitationExchangeChecksCurrentCandidate(t *testing.T) {
	for _, tc := range []struct {
		name, user, org, role string
		status                int
	}{
		{"assigned candidate", "candidate-a", "org-a", "CANDIDATE", 200},
		{"other candidate", "candidate-b", "org-a", "CANDIDATE", 403},
		{"other organization", "candidate-a", "org-b", "CANDIDATE", 403},
		{"staff", "candidate-a", "org-a", "ORG_ADMIN", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := accessFixture(t, attemptSession, false)
			r := gin.New()
			s.registerAttemptRoutes(r)
			token, _ := middleware.GenerateToken(tc.user, tc.org, tc.role, "a@example.com")
			w := testRequest(t, r, "POST", "/api/exam/access", token, `{"invitation_token":"locator"}`, tc.status)
			if tc.status == 200 {
				responseToken(t, w)
				if w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("credentials are cacheable")
				}
			}
		})
	}
}

func TestSpoofedTelemetryAndLegacyIdentityAreRejected(t *testing.T) {
	for _, kind := range []string{attemptSession, attemptLegacy} {
		s, repo := accessFixture(t, kind, true)
		r := gin.New()
		s.registerAttemptRoutes(r)
		token := issuedToken(t, s, repo.record)
		for _, body := range []string{`{"student_id":"other","violation_type":"FOCUS"}`, `{"blueprint_id":"other","violation_type":"FOCUS"}`} {
			testRequest(t, r, "POST", "/api/proctor/incidents", token, body, 403)
		}
		if kind == attemptLegacy {
			testRequest(t, r, "POST", "/api/assessments/assessment-a/start", token, `{"student_id":"other"}`, 403)
			testRequest(t, r, "POST", "/api/assessments/assessment-a/submit", token, `{"student_id":"other","answers":[]}`, 403)
		}
	}
}

func TestAccessFailsClosedOnDependencyError(t *testing.T) {
	s, repo := accessFixture(t, attemptSession, true)
	repo.err = errors.New("database offline")
	r := gin.New()
	r.POST("/attempt", s.attempts.require("", "incident"), func(c *gin.Context) { c.Status(204) })
	testRequest(t, r, "POST", "/attempt", issuedToken(t, s, repo.record), `{}`, 503)
	s.limits = &memoryRequestLimits{err: errors.New("redis offline")}
	r = gin.New()
	r.POST("/limited", s.limitAttemptRequests("test", 1, time.Minute), func(c *gin.Context) { c.Status(204) })
	testRequest(t, r, "POST", "/limited", "", `{}`, 503)
}

func TestRateAndPayloadLimits(t *testing.T) {
	s, _ := accessFixture(t, attemptSession, false)
	r := gin.New()
	r.POST("/limited", s.limitAttemptRequests("test", 1, time.Minute), func(c *gin.Context) { c.Status(204) })
	testRequest(t, r, "POST", "/limited", "", `{}`, 204)
	w := testRequest(t, r, "POST", "/limited", "", `{}`, 429)
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("missing retry guidance")
	}
	r = gin.New()
	r.POST("/body", limitRequestBody(4), func(c *gin.Context) { c.Status(204) })
	testRequest(t, r, "POST", "/body", "", "12345", 413)
	req := httptest.NewRequest("POST", "/body", strings.NewReader("12345"))
	req.ContentLength = -1
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 413 {
		t.Fatalf("unbounded/chunked body: %d", w.Code)
	}
}
