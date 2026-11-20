package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/mail"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"assessment/workerqueue"
	"github.com/jackc/pgx/v5/pgxpool"
)

type NotificationEventPayload struct {
	Event             string    `json:"event"`
	RecipientEmail    string    `json:"recipient_email"`
	CandidateName     string    `json:"candidate_name"`
	ExamTitle         string    `json:"exam_title"`
	Passcode          string    `json:"passcode"`
	TemporaryPassword string    `json:"temporary_password"`
	ScheduledStart    time.Time `json:"scheduled_start"`
	ScheduledEnd      time.Time `json:"scheduled_end"`
	BlueprintID       string    `json:"blueprint_id"`
	StudentID         string    `json:"student_id"`
	ClientDownloadURL string    `json:"client_download_url"`
	InvitationToken   string    `json:"invitation_token"`
	InvitationURL     string    `json:"invitation_url"`
	ProctoringMode    string    `json:"proctoring_mode"`
	AssessmentID      string    `json:"assessment_id"`
}

type Worker struct {
	db     *pgxpool.Pool
	sender *MailSender
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	_ = publicAppURL()
	dbpool, err := pgxpool.New(ctx, requiredEnv("ASSESSMENT_DATABASE_URL"))
	if err != nil {
		log.Fatal("Invalid notification database configuration")
	}
	defer dbpool.Close()
	sender, err := loadMailSender()
	if err != nil {
		log.Fatal(err)
	}
	worker := &Worker{db: dbpool, sender: sender}
	cfg, err := workerqueue.LoadConfig("notification_events", requiredEnv("RABBITMQ_URL"))
	if err != nil {
		log.Fatal(err)
	}
	runner := workerqueue.New(cfg, dbpool, func(ctx context.Context, job workerqueue.Job) error {
		var ev NotificationEventPayload
		if json.Unmarshal(job.Body, &ev) != nil {
			return workerqueue.Permanent("INVALID_PAYLOAD")
		}
		if ev.Event != "EXAM_INVITATION" && ev.Event != "PROCTOR_INVITE" && ev.Event != "CANDIDATE_ORG_INVITE" {
			return workerqueue.Permanent("INVALID_NOTIFICATION_TYPE")
		}
		if _, err := mail.ParseAddress(ev.RecipientEmail); err != nil {
			return workerqueue.Permanent("INVALID_RECIPIENT")
		}
		if strings.ContainsAny(ev.ExamTitle, "\r\n") {
			return workerqueue.Permanent("INVALID_NOTIFICATION_TITLE")
		}
		return worker.dispatchNotification(ctx, job, ev)
	})
	if err := runner.Run(ctx); err != nil {
		log.Fatal(err)
	}
}

func (w *Worker) dispatchNotification(ctx context.Context, job workerqueue.Job, ev NotificationEventPayload) error {
	gatewayURL := ev.InvitationURL
	if gatewayURL == "" {
		appURL := publicAppURL()
		gatewayURL = fmt.Sprintf("%s/exg/%s", appURL, url.PathEscape(ev.InvitationToken))
	}
	var htmlBody string
	if ev.Event == "PROCTOR_INVITE" {
		htmlBody = renderProctorInviteEmail(ev.CandidateName, ev.Passcode, gatewayURL)
	} else if ev.Event == "CANDIDATE_ORG_INVITE" {
		htmlBody = renderCandidateOrgInviteEmail(ev.CandidateName, ev.ExamTitle, gatewayURL)
	} else {
		appURL := publicAppURL()
		htmlBody = renderInvitationEmail(ev.CandidateName, ev.RecipientEmail, ev.ExamTitle, ev.Passcode, ev.TemporaryPassword, ev.ScheduledStart, ev.ScheduledEnd, gatewayURL, appURL+"/candidate", ev.ClientDownloadURL, ev.ProctoringMode)
	}

	subjectPrefix := "Assessment Invitation"
	if ev.Event == "PROCTOR_INVITE" {
		subjectPrefix = "Proctor Portal Invitation"
	} else if ev.Event == "CANDIDATE_ORG_INVITE" {
		subjectPrefix = "Organization Candidate Invitation"
	}
	deliveryErr := w.sender.Send(ctx, ev.RecipientEmail, "["+subjectPrefix+"] "+ev.ExamTitle, htmlBody)
	status := "SENT"
	var errorCode *string
	if w.sender.mode == "mock" {
		status = "MOCK_SENT"
	}
	if deliveryErr != nil {
		status = "FAILED"
		code := "SMTP_FAILED"
		if ctx.Err() != nil {
			code = "PROCESSING_TIMEOUT"
		}
		errorCode = &code
	}
	// SMTP acceptance precedes the transaction; a crash in that window can
	// resend. Once committed, audit and job completion are atomic before ACK.
	tx, err := w.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO notification_logs(job_id,attempt,recipient_email,template_type,status,error_message) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,attempt) DO NOTHING`, job.ID, job.Attempt, ev.RecipientEmail, ev.Event, status, errorCode)
	if err == nil && deliveryErr == nil {
		err = workerqueue.CompleteInTransaction(ctx, tx)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	return deliveryErr
}
