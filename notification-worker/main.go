package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/smtp"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
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
	mqChan *amqp.Channel
}

func main() {
	ctx := context.Background()

	// 1. PostgreSQL connection
	databaseURL := requiredEnv("ASSESSMENT_DATABASE_URL")
	dbpool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("Database connection failed: %v\n", err)
	}
	defer dbpool.Close()

	if err := dbpool.Ping(ctx); err != nil {
		log.Fatalf("Database ping failed: %v\n", err)
	}

	// 2. RabbitMQ connection
	rabbitMQURL := requiredEnv("RABBITMQ_URL")
	var mqConn *amqp.Connection
	for attempt := 1; ; attempt++ {
		mqConn, err = amqp.Dial(rabbitMQURL)
		if err == nil {
			break
		}
		log.Printf("RabbitMQ not ready (attempt %d): %v; retrying in 2 seconds", attempt, err)
		time.Sleep(2 * time.Second)
	}
	defer mqConn.Close()

	mqChan, err := mqConn.Channel()
	if err != nil {
		log.Fatalf("RabbitMQ channel opening failed: %v\n", err)
	}
	defer mqChan.Close()

	q, err := mqChan.QueueDeclare(
		"notification_events",
		true,  // durable
		false, // delete when unused
		false, // exclusive
		false, // no-wait
		nil,
	)
	if err != nil {
		log.Fatalf("Queue declaration error: %v\n", err)
	}

	// Fair dispatch prefetch
	err = mqChan.Qos(1, 0, false)
	if err != nil {
		log.Fatalf("Failed to set QoS: %v\n", err)
	}

	msgs, err := mqChan.Consume(
		q.Name,
		"notification_worker",
		false, // manual ack
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Fatalf("Consumer registration failed: %v\n", err)
	}

	worker := &Worker{db: dbpool, mqChan: mqChan}

	log.Println("[*] Notification Worker online. Consuming 'notification_events'...")

	for d := range msgs {
		var event NotificationEventPayload
		if err := json.Unmarshal(d.Body, &event); err != nil {
			log.Printf("[-] Failed to deserialize event: %v\n", err)
			d.Nack(false, false)
			continue
		}

		log.Printf("[+] Processing notification [%s] for %s (%s)", event.Event, event.CandidateName, event.RecipientEmail)

		err := worker.dispatchNotification(ctx, event)
		if err != nil {
			log.Printf("[-] Error delivering email: %v\n", err)
			d.Nack(false, true) // Requeue on transient network/SMTP failure
			continue
		}

		d.Ack(false)
	}
}

func (w *Worker) dispatchNotification(ctx context.Context, ev NotificationEventPayload) error {
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

	// Check if production SMTP configuration exists; if not, run mock delivery
	smtpHost := os.Getenv("SMTP_HOST")
	smtpPort := os.Getenv("SMTP_PORT")
	senderEmail := os.Getenv("SMTP_SENDER")
	if senderEmail == "" {
		senderEmail = "no-reply@assessmentplatform.internal"
	}

	var deliveryErr error
	if smtpHost != "" && smtpPort != "" {
		subjectPrefix := "Assessment Invitation"
		if ev.Event == "PROCTOR_INVITE" {
			subjectPrefix = "Proctor Portal Invitation"
		} else if ev.Event == "CANDIDATE_ORG_INVITE" {
			subjectPrefix = "Organization Candidate Invitation"
		}
		subject := fmt.Sprintf("Subject: [%s] %s\r\n", subjectPrefix, ev.ExamTitle)
		mime := "MIME-version: 1.0;\nContent-Type: text/html; charset=\"UTF-8\";\r\n\r\n"
		msg := []byte(subject + mime + htmlBody)

		addr := fmt.Sprintf("%s:%s", smtpHost, smtpPort)
		deliveryErr = smtp.SendMail(addr, nil, senderEmail, []string{ev.RecipientEmail}, msg)
	} else {
		// Mock transmission logging for local verification
		log.Printf("    [MOCK-SMTP] Delivered invitation email to %s", ev.RecipientEmail)
	}

	// Audit record in notification_logs
	status := "SENT"
	var errText *string
	if deliveryErr != nil {
		status = "FAILED"
		msg := deliveryErr.Error()
		errText = &msg
	}

	_, logErr := w.db.Exec(ctx, `
		INSERT INTO notification_logs (recipient_email, template_type, status, error_message)
		VALUES ($1, $2, $3, $4)`,
		ev.RecipientEmail, ev.Event, status, errText,
	)
	if logErr != nil {
		log.Printf("Failed to commit notification audit row: %v\n", logErr)
	}

	return deliveryErr
}
