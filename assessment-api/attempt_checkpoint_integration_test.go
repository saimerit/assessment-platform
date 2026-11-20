package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"assessment-api/middleware"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type publisherFunc func(context.Context, string, string, []byte) error

func (f publisherFunc) Publish(ctx context.Context, queue, id string, body []byte) error {
	return f(ctx, queue, id, body)
}

func TestCheckpointIntegration(t *testing.T) {
	t.Setenv("CLIENT_RELEASE_URL", "https://example.test/client.exe")
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("run scripts/test-attempt-access.ps1 for isolated integration tests")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil || parsed.Path != "/assessment_attempt_auth_test" {
		t.Fatal("requires isolated test database")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ro, err := redis.ParseURL(os.Getenv("TEST_REDIS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(ro)
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
	suffix := newCheckpointUpdateID()
	org := newID(`INSERT INTO organizations(name,domain) VALUES('Checkpoint tests',$1)`, suffix+".test")
	candidate := newID(`INSERT INTO users(org_id,email,password_hash,full_name,role,registration_status) VALUES($1,$2,'unused','Recovery candidate','CANDIDATE','REGISTERED')`, org, suffix+"@checkpoint.test")
	other := newID(`INSERT INTO users(org_id,email,password_hash,full_name,role,registration_status) VALUES($1,$2,'unused','Other candidate','CANDIDATE','REGISTERED')`, org, "other-"+suffix+"@checkpoint.test")
	bank := newID(`INSERT INTO question_banks(org_id,name) VALUES($1,'Checkpoint bank')`, org)
	text := newID(`INSERT INTO questions(bank_id,title,statement,q_type) VALUES($1,'Text','Answer text','FIB')`, bank)
	mcq := newID(`INSERT INTO questions(bank_id,title,statement,q_type) VALUES($1,'Choice','Select options','MCQ')`, bank)
	foreign := newID(`INSERT INTO questions(bank_id,title,statement,q_type) VALUES($1,'Outside paper','Outside','MCQ')`, bank)
	option := newID(`INSERT INTO mcq_options(question_id,option_text) VALUES($1,'Allowed')`, mcq)
	foreignOption := newID(`INSERT INTO mcq_options(question_id,option_text) VALUES($1,'Outside')`, foreign)
	exec(`INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_text) VALUES($1,'FIB','durable text')`, text)
	exec(`INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_option_id,expected_option_ids) VALUES($1,'MCQ',$2,ARRAY[$2::uuid])`, mcq, option)
	topic := newID(`INSERT INTO topics(org_id,name) VALUES($1,$2)`, org, "checkpoint-"+suffix)
	subcategory := newID(`INSERT INTO subcategories(topic_id,name) VALUES($1,'Recovery')`, topic)
	exec(`UPDATE questions SET subcategory_id=$1 WHERE id=ANY($2::uuid[])`, subcategory, []string{text, mcq})
	foreignOrg := newID(`INSERT INTO organizations(name,domain) VALUES('Foreign checkpoint organization',$1)`, "foreign-"+suffix+".test")
	foreignBank := newID(`INSERT INTO question_banks(org_id,name) VALUES($1,'Foreign bank')`, foreignOrg)
	newID(`INSERT INTO questions(bank_id,subcategory_id,title,statement,q_type) VALUES($1,$2,'Foreign bank question','Never include','FIB')`, foreignBank, subcategory)
	account, _ := middleware.GenerateToken(candidate, org, "CANDIDATE", suffix+"@checkpoint.test")
	otherAccount, _ := middleware.GenerateToken(other, org, "CANDIDATE", "other@checkpoint.test")
	for _, kind := range []string{attemptSession, attemptLegacy} {
		t.Run(kind, func(t *testing.T) {
			invitation := kind + suffix
			var id, assessment, path, instance string
			if kind == attemptSession {
				assessment = newID(`INSERT INTO assessment_events(org_id,title,mode,scheduled_start,scheduled_end,duration_minutes) VALUES($1,'Recovery exam','OFFLINE_NORMAL',NOW()-interval '5 minutes',NOW()+interval '1 hour',60)`, org)
				paper := newID(`INSERT INTO assessment_papers(assessment_id,paper_code,set_name) VALUES($1,$2,'Recovery')`, assessment, suffix[:16])
				exec(`INSERT INTO paper_questions(paper_id,question_id,sort_order) VALUES($1,$2,1),($1,$3,2)`, paper, mcq, text)
				id = newID(`INSERT INTO candidate_sessions(assessment_id,paper_id,student_id,invitation_token) VALUES($1,$2,$3,$4)`, assessment, paper, candidate, invitation)
				instance = id
				path = "/api/exam/sessions/" + id
				if err := rdb.Set(ctx, "event_passcode:"+assessment, "123456", time.Hour).Err(); err != nil {
					t.Fatal(err)
				}
			} else {
				assessment = newID(`INSERT INTO assessment_blueprints(org_id,title,duration_minutes) VALUES($1,'Legacy recovery',60)`, org)
				id = newID(`INSERT INTO assessment_invitations(blueprint_id,student_id,invitation_token,scheduled_start,scheduled_end,passcode_hash) VALUES($1,$2,$3,NOW()-interval '5 minutes',NOW()+interval '1 hour','unused')`, assessment, candidate, invitation)
				newID(`INSERT INTO blueprint_rules(blueprint_id,topic_id,difficulty,question_count) VALUES($1,$2,'MEDIUM',2)`, assessment, topic)
				path = "/api/assessments/" + assessment
				if err := rdb.Set(ctx, "passcode:"+assessment+":"+candidate, "123456", time.Hour).Err(); err != nil {
					t.Fatal(err)
				}
			}
			router := func() *gin.Engine {
				r := gin.New()
				_ = r.SetTrustedProxies(nil)
				s.registerAttemptRoutes(r)
				r.GET("/gateway/:token", s.HandleExamGateway)
				r.GET("/api/candidate/assessments", middleware.AuthMiddleware(), middleware.RequireRoles("CANDIDATE"), s.GetCandidateAssessments)
				return r
			}
			r := router()
			checkin := responseToken(t, testRequest(t, r, "POST", "/api/exam/access", account, `{"invitation_token":"`+invitation+`"}`, 200))
			testRequest(t, r, "GET", path+"/checkpoint", "", "", 401)
			testRequest(t, r, "GET", path+"/checkpoint", account, "", 401)
			testRequest(t, r, "GET", path+"/checkpoint", checkin, "", 403)
			testRequest(t, r, "POST", "/api/exam/access", otherAccount, `{"invitation_token":"`+invitation+`"}`, 403)
			unlockPath := "/unlock"
			if kind == attemptLegacy {
				unlockPath = "/verify-passcode"
			}
			active := responseToken(t, testRequest(t, r, "POST", path+unlockPath, checkin, `{"passcode":"123456"}`, 200))
			testRequest(t, r, "GET", path+"/checkpoint", active, "", 403)

			start := testRequest(t, r, "POST", path+"/start", active, `{}`, 200)
			var timer map[string]any
			_ = json.Unmarshal(start.Body.Bytes(), &timer)
			if kind == attemptLegacy {
				instance = timer["instance_id"].(string)
				questions := timer["questions"].([]any)
				if len(questions) != 2 {
					t.Fatal("generated legacy paper size changed")
				}
				for _, question := range questions {
					id := question.(map[string]any)["question_id"].(string)
					if id != mcq && id != text {
						t.Fatal("legacy generation crossed organization boundary")
					}
				}
			}
			get := func() checkpointState {
				t.Helper()
				out := testRequest(t, r, "GET", path+"/checkpoint", active, "", 200)
				var state checkpointState
				if err := json.Unmarshal(out.Body.Bytes(), &state); err != nil {
					t.Fatal(err)
				}
				return state
			}
			save := func(update checkpointUpdate, status int) checkpointState {
				t.Helper()
				body, _ := json.Marshal(update)
				out := testRequest(t, r, "PUT", path+"/checkpoint", active, string(body), status)
				var state checkpointState
				_ = json.Unmarshal(out.Body.Bytes(), &state)
				return state
			}
			initial := get()
			if initial.Revision != 0 || len(initial.Answers) != 0 {
				t.Fatal("unexpected initial checkpoint")
			}
			response := "durable text"
			update := checkpointUpdate{UpdateID: newCheckpointUpdateID(), Answers: []checkpointAnswer{{QuestionID: mcq, SelectedOptionIDs: []string{option}, Reviewed: true}, {QuestionID: text, TypedResponse: &response}}, Navigation: &checkpointNavigation{QuestionID: &text, ActiveView: "question"}}
			saved := save(update, 200)
			if saved.Revision != 1 || len(saved.Answers) != 2 || *saved.Navigation.QuestionID != text || saved.SavedAt == nil {
				t.Fatal("save lost checkpoint metadata")
			}
			duplicate := save(update, 200)
			if duplicate.Revision != 1 {
				t.Fatal("duplicate advanced revision")
			}
			changed := update
			changed.Answers = []checkpointAnswer{{QuestionID: mcq, SelectedOptionIDs: []string{}}}
			save(changed, 409)
			stale := changed
			stale.UpdateID = newCheckpointUpdateID()
			save(stale, 409)
			stale.BaseRevision = 1
			save(stale, 200)
			blank := ""
			cleared := save(checkpointUpdate{UpdateID: newCheckpointUpdateID(), BaseRevision: 2, Answers: []checkpointAnswer{{QuestionID: text, TypedResponse: &blank, Reviewed: true}}}, 200)
			for _, a := range cleared.Answers {
				if nonemptyAnswer(a) {
					t.Fatal("clear/blank still counted as answered")
				}
			}
			bad := []checkpointAnswer{{QuestionID: foreign}, {QuestionID: mcq, SelectedOptionIDs: []string{foreignOption}}, {QuestionID: mcq, TypedResponse: &response}, {QuestionID: text, SelectedOptionIDs: []string{option}}, {QuestionID: mcq, SelectedOptionIDs: []string{option, option}}}
			for _, a := range bad {
				save(checkpointUpdate{UpdateID: newCheckpointUpdateID(), BaseRevision: 3, Answers: []checkpointAnswer{a}}, 400)
			}
			save(checkpointUpdate{UpdateID: newCheckpointUpdateID(), BaseRevision: 3, Navigation: &checkpointNavigation{QuestionID: &foreign, ActiveView: "question"}}, 400)
			if get().Revision != 3 {
				t.Fatal("invalid request mutated state")
			}
			// Two writers start from the same revision. Parent locking permits one CAS winner.
			var wg sync.WaitGroup
			statuses := make(chan int, 2)
			for range 2 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					body, _ := json.Marshal(checkpointUpdate{UpdateID: newCheckpointUpdateID(), BaseRevision: 3, Answers: []checkpointAnswer{{QuestionID: text, TypedResponse: &response, Reviewed: true}}})
					req := httptest.NewRequest("PUT", path+"/checkpoint", strings.NewReader(string(body)))
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Authorization", "Bearer "+active)
					out := httptest.NewRecorder()
					r.ServeHTTP(out, req)
					statuses <- out.Code
				}()
			}
			wg.Wait()
			close(statuses)
			total := 0
			for status := range statuses {
				total += status
			}
			if total != 609 {
				t.Fatalf("concurrent saves not 200+409: %d", total)
			}
			if kind == attemptSession {
				exec(`UPDATE assessment_events SET duration_minutes=1,scheduled_end=NOW()-interval '1 minute' WHERE id=$1`, assessment)
			} else {
				exec(`UPDATE assessment_blueprints SET duration_minutes=1 WHERE id=$1`, assessment)
				exec(`UPDATE assessment_invitations SET scheduled_end=NOW()-interval '1 minute' WHERE id=$1`, id)
			}
			// Recreate the server/router and obtain a fresh candidate-bound credential.
			r = router()
			active = responseToken(t, testRequest(t, r, "POST", "/api/exam/access", account, `{"invitation_token":"`+invitation+`"}`, 200))
			testRequest(t, r, "POST", path+unlockPath, active, `{"passcode":"123456"}`, 200)
			resumed := testRequest(t, r, "POST", path+"/start", active, `{}`, 200)
			var resumedTimer map[string]any
			_ = json.Unmarshal(resumed.Body.Bytes(), &resumedTimer)
			if timer["started_at"] != resumedTimer["started_at"] || timer["timer_expires_at"] != resumedTimer["timer_expires_at"] || resumedTimer["duration_minutes"] != float64(60) {
				t.Fatalf("resume changed original deadline/duration: first=%v resumed=%v", timer, resumedTimer)
			}
			restored := get()
			if restored.Revision != 4 || len(restored.Answers) != 2 || *restored.Navigation.QuestionID != text {
				t.Fatal("restart lost acknowledged checkpoint")
			}
			gateway := testRequest(t, r, "GET", "/gateway/"+invitation, "", "", 200)
			var gatewayData ExamGatewayResponse
			_ = json.Unmarshal(gateway.Body.Bytes(), &gatewayData)
			if gatewayData.WindowStatus != "IN_PROGRESS" || gatewayData.DurationMinutes != 60 || !gatewayData.TimerExpiresAt.Equal(*restored.Deadline) {
				t.Fatal("gateway did not use pinned lifecycle")
			}
			// Deadline writes are rejected; a revision-only submit can freeze the durable snapshot.
			if kind == attemptSession {
				exec(`UPDATE candidate_sessions SET timer_expires_at=NOW()-interval '1 second' WHERE id=$1`, id)
			} else {
				exec(`UPDATE candidate_assessment_instances SET timer_expires_at=NOW()-interval '1 second' WHERE id=$1`, instance)
			}
			testRequest(t, r, "PUT", path+"/checkpoint", active, `{"update_id":"`+newCheckpointUpdateID()+`","base_revision":4,"answers":[]}`, 403)
			testRequest(t, r, "POST", path+"/submit", active, `{"answers":[{"question_id":"`+text+`","typed_response":"late"}]}`, 403)
			// A failed outbox insert must roll back the receipt and submitted state.
			exec(fmt.Sprintf(`ALTER TABLE submission_outbox ADD CONSTRAINT test_atomic_outbox CHECK(payload->>'student_id'<>'%s') NOT VALID`, candidate))
			testRequest(t, r, "POST", path+"/submit", active, `{"checkpoint_revision":4}`, 503)
			var receipts int
			if err := db.QueryRow(ctx, `SELECT count(*) FROM attempt_submissions WHERE student_id=$1 AND assessment_id=$2`, candidate, assessment).Scan(&receipts); err != nil || receipts != 0 {
				t.Fatal("failed delivery insert left a receipt", err)
			}
			exec(`ALTER TABLE submission_outbox DROP CONSTRAINT test_atomic_outbox`)
			firstSubmit := testRequest(t, r, "POST", path+"/submit", active, `{"checkpoint_revision":0}`, 202)
			var receipt submissionReceipt
			_ = json.Unmarshal(firstSubmit.Body.Bytes(), &receipt)
			if receipt.Reason != "DEADLINE" || receipt.Revision != 4 || receipt.Answered != 1 {
				t.Fatal("deadline receipt did not freeze accepted snapshot")
			}
			var publicReceipt map[string]any
			_ = json.Unmarshal(firstSubmit.Body.Bytes(), &publicReceipt)
			for _, key := range []string{"grading_status", "delivery_status", "score", "answers"} {
				if _, exposed := publicReceipt[key]; exposed {
					t.Fatalf("candidate receipt exposed %s", key)
				}
			}
			for range 2 {
				again := testRequest(t, r, "POST", path+"/submit", active, `{"checkpoint_revision":4}`, 200)
				var duplicate submissionReceipt
				_ = json.Unmarshal(again.Body.Bytes(), &duplicate)
				if duplicate.SubmissionID != receipt.SubmissionID || !duplicate.FinalizedAt.Equal(receipt.FinalizedAt) {
					t.Fatal("repeated submit changed receipt")
				}
			}
			testRequest(t, r, "GET", path+"/receipt", account, "", 401)
			testRequest(t, r, "GET", path+"/receipt", active, "", 200)
			renewed := responseToken(t, testRequest(t, r, "POST", "/api/exam/access", account, `{"invitation_token":"`+invitation+`"}`, 200))
			testRequest(t, r, "GET", path+"/receipt", renewed, "", 200)
			testRequest(t, r, "POST", path+"/start", renewed, `{}`, 403)
			exec(`UPDATE submission_outbox SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE submission_id<>$1`, receipt.SubmissionID)
			s.messages = publisherFunc(func(context.Context, string, string, []byte) error { return errors.New("broker unavailable") })
			if worked, err := s.dispatchSubmission(ctx); !worked || err != nil {
				t.Fatal("broker outage did not leave a retryable record", err)
			}
			var pending bool
			var attempts int
			if err := db.QueryRow(ctx, `SELECT delivered_at IS NULL,attempts FROM submission_outbox WHERE submission_id=$1`, receipt.SubmissionID).Scan(&pending, &attempts); err != nil || !pending || attempts != 1 {
				t.Fatal("broker failure lost pending delivery", err)
			}
			exec(`UPDATE submission_outbox SET next_attempt_at=clock_timestamp() WHERE submission_id=$1`, receipt.SubmissionID)
			published := 0
			s.messages = publisherFunc(func(_ context.Context, queue, id string, body []byte) error {
				published++
				if id != receipt.SubmissionID || queue != "assessment_submissions" {
					return errors.New("wrong submission identity")
				}
				return nil
			})
			// Simulate confirmed publication followed by failure of the DB acknowledgment.
			exec(`ALTER TABLE submission_outbox ADD CONSTRAINT test_delivery_ack CHECK(delivered_at IS NULL) NOT VALID`)
			if _, err := s.dispatchSubmission(ctx); err == nil {
				t.Fatal("expected simulated DB acknowledgment failure")
			}
			exec(`ALTER TABLE submission_outbox DROP CONSTRAINT test_delivery_ack`)
			if _, err := s.dispatchSubmission(ctx); err != nil {
				t.Fatal(err)
			}
			if published != 2 {
				t.Fatal("ambiguous delivery did not retry stable submission")
			}
			if err := db.QueryRow(ctx, `SELECT delivered_at IS NULL FROM submission_outbox WHERE submission_id=$1`, receipt.SubmissionID).Scan(&pending); err != nil || pending {
				t.Fatal("confirmed delivery not recorded", err)
			}
			table, key := "candidate_sessions", "session_id"
			if kind == attemptLegacy {
				table, key = "candidate_assessment_instances", "instance_id"
			}
			var status string
			if err := db.QueryRow(ctx, "SELECT status FROM "+table+" WHERE id=$1", instance).Scan(&status); err != nil || status != "SUBMITTED" {
				t.Fatal("durable submit did not commit", err)
			}
			var count int
			answersTable := "candidate_session_answers"
			if kind == attemptLegacy {
				answersTable = "candidate_answers"
			}
			if err := db.QueryRow(ctx, "SELECT count(*) FROM "+answersTable+" WHERE "+key+"=$1", instance).Scan(&count); err != nil || count != 2 {
				t.Fatal("submission lost durable answers", err)
			}
			testRequest(t, r, "GET", path+"/checkpoint", active, "", 403)
			// A save arriving while the parent is locked must recheck the DB deadline
			// after the lock; a disconnected candidate receives automatic finalization.
			var shortID, shortInstance, shortPath string
			shortInvitation := "deadline-" + kind + suffix[:16]
			if kind == attemptSession {
				var paper string
				_ = db.QueryRow(ctx, `SELECT paper_id::text FROM candidate_sessions WHERE id=$1`, id).Scan(&paper)
				shortID = newID(`INSERT INTO candidate_sessions(assessment_id,paper_id,student_id,invitation_token,status,unlocked_at,started_at,timer_expires_at) VALUES($1,$2,$3,$4,'IN_PROGRESS',clock_timestamp(),clock_timestamp()-interval '1 minute',clock_timestamp()+interval '800 milliseconds')`, assessment, paper, other, shortInvitation)
				shortInstance = shortID
				shortPath = "/api/exam/sessions/" + shortID
			} else {
				shortID = newID(`INSERT INTO assessment_invitations(blueprint_id,student_id,invitation_token,scheduled_start,scheduled_end,passcode_hash,unlocked_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','test-only',clock_timestamp())`, assessment, other, shortInvitation)
				shortInstance = newID(`INSERT INTO candidate_assessment_instances(blueprint_id,student_id,status,started_at,timer_expires_at) VALUES($1,$2,'IN_PROGRESS',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '800 milliseconds')`, assessment, other)
				exec(`INSERT INTO instance_questions(instance_id,question_id,display_order) VALUES($1,$2,1),($1,$3,2)`, shortInstance, mcq, text)
				shortPath = "/api/assessments/" + assessment
			}
			var snapshot string
			if err := db.QueryRow(ctx, `SELECT pin_attempt_paper($1,$2::uuid,$3::uuid,$4::uuid)::text`, kind, shortID, org, other).Scan(&snapshot); err != nil {
				t.Fatal(err)
			}
			shortToken := responseToken(t, testRequest(t, r, "POST", "/api/exam/access", otherAccount, `{"invitation_token":"`+shortInvitation+`"}`, 200))
			hold, err := db.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var lockedID string
			if err = hold.QueryRow(ctx, "SELECT id::text FROM "+func() string {
				if kind == attemptLegacy {
					return "assessment_invitations"
				}
				return "candidate_sessions"
			}()+" WHERE id=$1 FOR UPDATE", shortID).Scan(&lockedID); err != nil {
				t.Fatal(err)
			}
			result := make(chan int, 1)
			go func() {
				body := `{"update_id":"` + newCheckpointUpdateID() + `","base_revision":0,"answers":[]}`
				req := httptest.NewRequest("PUT", shortPath+"/checkpoint", strings.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+shortToken)
				req.Header.Set("Content-Type", "application/json")
				out := httptest.NewRecorder()
				r.ServeHTTP(out, req)
				result <- out.Code
			}()
			time.Sleep(1100 * time.Millisecond)
			_ = hold.Commit(ctx)
			if status := <-result; status != 403 {
				t.Fatalf("blocked late save got %d", status)
			}
			if err = s.sweepSubmissions(ctx); err != nil {
				t.Fatal(err)
			}
			a, err := s.attempts.repository.FindAttempt(ctx, kind, shortID)
			if err != nil {
				t.Fatal(err)
			}
			auto, err := readSubmissionReceipt(ctx, db, a)
			if err != nil || auto.Reason != "DEADLINE" || auto.Answered != 0 || auto.Revision != 0 {
				t.Fatal("disconnected unanswered attempt was not finalized", err)
			}
			// Older workers could save a result without advancing attempt status.
			// Recover its receipt without scheduling another grade or changing it.
			exec(`DELETE FROM attempt_submissions WHERE id=$1`, auto.SubmissionID)
			resultQuery := `SELECT score_obtained,max_score,evaluated_at FROM candidate_session_results WHERE session_id=$1`
			if kind == attemptSession {
				exec(`INSERT INTO candidate_session_results(session_id,score_obtained,max_score) VALUES($1,0.5,2)`, shortInstance)
			} else {
				exec(`INSERT INTO candidate_results(instance_id,total_score,max_score) VALUES($1,0.5,2)`, shortInstance)
				resultQuery = `SELECT total_score,max_score,evaluated_at FROM candidate_results WHERE instance_id=$1`
			}
			var score, maximum float64
			var evaluated, after time.Time
			if err = db.QueryRow(ctx, resultQuery, shortInstance).Scan(&score, &maximum, &evaluated); err != nil {
				t.Fatal(err)
			}
			if err = s.sweepSubmissions(ctx); err != nil {
				t.Fatal(err)
			}
			recoveredReceipt, err := readSubmissionReceipt(ctx, db, a)
			if err != nil || recoveredReceipt.Reason != "RECOVERED" || recoveredReceipt.GradingStatus != "GRADED" {
				t.Fatal("historical evaluated submission was not preserved", err)
			}
			var jobs int
			if err = db.QueryRow(ctx, `SELECT count(*) FROM submission_outbox WHERE submission_id=$1`, recoveredReceipt.SubmissionID).Scan(&jobs); err != nil || jobs != 0 {
				t.Fatal("historical result scheduled for regrading", err)
			}
			if err = db.QueryRow(ctx, resultQuery, shortInstance).Scan(&score, &maximum, &after); err != nil || score != 0.5 || maximum != 2 || !after.Equal(evaluated) {
				t.Fatal("historical result changed during receipt recovery", err)
			}
			// Grading is internal; candidates see only submission records until
			// an evaluator-controlled publication workflow is implemented.
			if kind == attemptSession {
				exec(`UPDATE candidate_sessions SET status='EVALUATED' WHERE id=$1`, shortInstance)
			} else {
				exec(`UPDATE candidate_assessment_instances SET status='EVALUATED' WHERE id=$1`, shortInstance)
			}
			listing := testRequest(t, r, "GET", "/api/candidate/assessments", otherAccount, "", 200)
			var records struct {
				Assessments []map[string]any `json:"assessments"`
			}
			_ = json.Unmarshal(listing.Body.Bytes(), &records)
			if len(records.Assessments) == 0 {
				t.Fatal("submission record missing from candidate schedule")
			}
			for _, record := range records.Assessments {
				for _, key := range []string{"score", "max_score", "evaluated_at", "grading_status"} {
					if _, exposed := record[key]; exposed {
						t.Fatalf("candidate schedule exposed %s", key)
					}
				}
				if record["status"] == "EVALUATED" {
					t.Fatal("candidate schedule exposed internal grading state")
				}
			}
		})
	}
}
