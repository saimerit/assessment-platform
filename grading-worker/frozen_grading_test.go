package main

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"
)

func TestFrozenScoringPolicy(t *testing.T) {
	text := " \tAnswer\n"
	empty := " \t\n"
	expected := "answer"
	cases := []struct {
		name string
		q    frozenQuestion
		a    frozenAnswer
		k    frozenKey
		want float64
	}{
		{"partial subset", frozenQuestion{Type: "MCQ", Marks: 4}, frozenAnswer{Options: []string{"a"}}, frozenKey{Type: "MCQ", Options: []string{"a", "b"}}, 2},
		{"wrong option", frozenQuestion{Type: "MCQ", Marks: 4}, frozenAnswer{Options: []string{"a", "wrong"}}, frozenKey{Type: "MCQ", Options: []string{"a", "b"}}, 0},
		{"duplicate rejected", frozenQuestion{Type: "MCQ", Marks: 4}, frozenAnswer{Options: []string{"a", "a"}}, frozenKey{Type: "MCQ", Options: []string{"a", "b"}}, 0},
		{"empty MCQ", frozenQuestion{Type: "MCQ", Marks: 4}, frozenAnswer{}, frozenKey{Type: "MCQ", Options: []string{"a"}}, 0},
		{"trimmed case insensitive", frozenQuestion{Type: "FIB", Marks: 2}, frozenAnswer{Text: &text}, frozenKey{Type: "FIB", Text: &expected}, 2},
		{"case sensitive", frozenQuestion{Type: "FIB", Marks: 2}, frozenAnswer{Text: &text}, frozenKey{Type: "FIB", Text: &expected, CaseSensitive: true}, 0},
		{"blank FIB", frozenQuestion{Type: "FIB", Marks: 2}, frozenAnswer{Text: &empty}, frozenKey{Type: "FIB", Text: &empty}, 0},
		{"missing FIB", frozenQuestion{Type: "FIB", Marks: 2}, frozenAnswer{}, frozenKey{Type: "FIB", Text: &expected}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := scoreFrozenAnswer(tc.q, tc.a, tc.k); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestFrozenGradingIntegration(t *testing.T) {
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("run scripts/test-attempt-access.ps1")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/assessment_attempt_auth_test" {
		t.Fatal("requires isolated test DB")
	}
	ctx := context.Background()
	root, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	parsed.User = url.UserPassword("assessment_grader", "test-grader-password")
	grader, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer grader.Close()
	for _, kind := range []string{"session", "legacy"} {
		t.Run(kind, func(t *testing.T) {
			id := func(query string, args ...any) string {
				t.Helper()
				var result string
				if err := root.QueryRow(ctx, query+" RETURNING id::text", args...).Scan(&result); err != nil {
					t.Fatal(err)
				}
				return result
			}
			exec := func(query string, args ...any) {
				t.Helper()
				if _, err := root.Exec(ctx, query, args...); err != nil {
					t.Fatal(err)
				}
			}
			var suffix string
			_ = root.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&suffix)
			org := id(`INSERT INTO organizations(name,domain) VALUES('Frozen grading',$1)`, suffix+".test")
			student := id(`INSERT INTO users(org_id,email,password_hash,full_name,role,registration_status) VALUES($1,$2,'test-only','Grading test','CANDIDATE','REGISTERED')`, org, suffix+"@grading.test")
			bank := id(`INSERT INTO question_banks(org_id,name) VALUES($1,'Frozen bank')`, org)
			mcq := id(`INSERT INTO questions(bank_id,title,statement,q_type,marks) VALUES($1,'Choice','Original statement','MCQ',4)`, bank)
			fib := id(`INSERT INTO questions(bank_id,title,statement,q_type,marks) VALUES($1,'Text','Original statement','FIB',2)`, bank)
			option := id(`INSERT INTO mcq_options(question_id,option_text) VALUES($1,'Original option')`, mcq)
			second := id(`INSERT INTO mcq_options(question_id,option_text) VALUES($1,'Second correct')`, mcq)
			exec(`INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_option_id,expected_option_ids) VALUES($1,'MCQ',$2,ARRAY[$2::uuid,$3::uuid])`, mcq, option, second)
			exec(`INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_text) VALUES($1,'FIB','answer')`, fib)
			var attempt, assessment, instance, session string
			if kind == "session" {
				assessment = id(`INSERT INTO assessment_events(org_id,title,mode,scheduled_start,scheduled_end) VALUES($1,'Frozen event','OFFLINE_NORMAL',NOW()-interval '1 hour',NOW()+interval '1 hour')`, org)
				paper := id(`INSERT INTO assessment_papers(assessment_id,paper_code) VALUES($1,'FROZEN')`, assessment)
				exec(`INSERT INTO paper_questions(paper_id,question_id,sort_order) VALUES($1,$2,1),($1,$3,2)`, paper, mcq, fib)
				attempt = id(`INSERT INTO candidate_sessions(assessment_id,paper_id,student_id,invitation_token,status,started_at,timer_expires_at,unlocked_at) VALUES($1,$2,$3,$4,'SUBMITTED',NOW()-interval '1 minute',NOW()+interval '1 hour',NOW())`, assessment, paper, student, suffix)
				session = attempt
			} else {
				assessment = id(`INSERT INTO assessment_blueprints(org_id,title) VALUES($1,'Frozen blueprint')`, org)
				attempt = id(`INSERT INTO assessment_invitations(blueprint_id,student_id,invitation_token,scheduled_start,scheduled_end,passcode_hash) VALUES($1,$2,$3,NOW()-interval '1 hour',NOW()+interval '1 hour','test-only')`, assessment, student, suffix)
				instance = id(`INSERT INTO candidate_assessment_instances(blueprint_id,student_id,status,started_at,timer_expires_at) VALUES($1,$2,'SUBMITTED',NOW()-interval '1 minute',NOW()+interval '1 hour')`, assessment, student)
				exec(`INSERT INTO instance_questions(instance_id,question_id,display_order) VALUES($1,$2,1),($1,$3,2)`, instance, mcq, fib)
			}
			var snapshot string
			if err := root.QueryRow(ctx, `SELECT pin_attempt_paper($1,$2::uuid,$3::uuid,$4::uuid)::text`, kind, attempt, org, student).Scan(&snapshot); err != nil {
				t.Fatal(err)
			}
			text := " \tAnswer\n"
			answers, _ := json.Marshal([]frozenAnswer{{ID: mcq, Options: []string{option}}, {ID: fib, Text: &text}})
			var receipt string
			err := root.QueryRow(ctx, `INSERT INTO attempt_submissions(session_id,invitation_id,instance_id,snapshot_id,org_id,student_id,assessment_id,checkpoint_revision,answers,question_count,answered_count,deadline,submitted_at,reason)
   VALUES(NULLIF($1,'')::uuid,CASE WHEN $2='legacy' THEN $3::uuid END,NULLIF($4,'')::uuid,$5,$6,$7,$8,1,$9,2,2,NOW()+interval '1 hour',NOW(),'MANUAL') RETURNING id::text`, session, kind, attempt, instance, snapshot, org, student, assessment, answers).Scan(&receipt)
			if err != nil {
				t.Fatal(err)
			}
			exec(`UPDATE questions SET marks=99,title='Changed after start',statement='Changed' WHERE id=ANY($1::uuid[])`, []string{mcq, fib})
			exec(`UPDATE mcq_options SET option_text='Changed option' WHERE id=$1`, option)
			exec(`UPDATE answer_vault.secure_answer_keys SET expected_text='changed key',case_sensitive=true WHERE question_id=$1`, fib)
			exec(`UPDATE answer_vault.secure_answer_keys SET expected_option_ids=ARRAY[$2::uuid] WHERE question_id=$1`, mcq, second)
			event := AssessmentSubmittedEvent{SubmissionID: receipt, Version: 1, SessionID: session, InstanceID: instance, StudentID: student, BlueprintID: assessment}
			var wg sync.WaitGroup
			for range 8 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if err := evaluateFrozenSubmission(ctx, grader, event); err != nil {
						t.Error(err)
					}
				}()
			}
			wg.Wait()
			var score, max float64
			var evaluated time.Time
			query := `SELECT score_obtained,max_score,evaluated_at FROM candidate_session_results WHERE session_id=$1`
			owner := session
			if kind == "legacy" {
				query = `SELECT total_score,max_score,evaluated_at FROM candidate_results WHERE instance_id=$1`
				owner = instance
			}
			if err := root.QueryRow(ctx, query, owner).Scan(&score, &max, &evaluated); err != nil {
				t.Fatal(err)
			}
			if score != 4 || max != 6 {
				t.Fatalf("pinned grade changed: %v/%v", score, max)
			}
			if err := evaluateFrozenSubmission(ctx, grader, event); err != nil {
				t.Fatal(err)
			}
			var after time.Time
			if err := root.QueryRow(ctx, query, owner).Scan(&score, &max, &after); err != nil || !after.Equal(evaluated) {
				t.Fatal("repeat delivery changed result", err)
			}
			oldEvent := event
			oldEvent.SubmissionID = ""
			oldEvent.Version = 0
			if err := evaluateSubmission(ctx, grader, oldEvent); err != nil {
				t.Fatal("legacy message did not resolve durable version", err)
			}
			event.Version = 2
			if evaluateFrozenSubmission(ctx, grader, event) == nil {
				t.Fatal("wrong version graded")
			}
			tx, err := root.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, err = tx.Exec(ctx, `SET LOCAL ROLE assessment_app`)
			if err != nil {
				t.Fatal(err)
			}
			var count int
			err = tx.QueryRow(ctx, `SELECT count(*) FROM answer_vault.attempt_snapshot_keys`).Scan(&count)
			_ = tx.Rollback(ctx)
			if err == nil {
				t.Fatal("application could read frozen grading keys")
			}
		})
	}
}
