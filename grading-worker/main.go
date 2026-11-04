package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
)

type AssessmentSubmittedEvent struct {
	InstanceID  string    `json:"instance_id"`
	SessionID   string    `json:"session_id,omitempty"`
	StudentID   string    `json:"student_id"`
	BlueprintID string    `json:"blueprint_id"`
	SubmittedAt time.Time `json:"submitted_at"`
}

func main() {
	ctx := context.Background()

	// 1. PostgreSQL Connection Pool
	databaseURL := os.Getenv("GRADING_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://assessment_grader:assessment_grader_dev_password@127.0.0.1:5433/assessment_db?sslmode=disable"
	}
	dbpool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("Unable to parse DB config: %v\n", err)
	}
	if err := dbpool.Ping(ctx); err != nil {
		log.Fatalf("Unable to connect to database: %v\n", err)
	}
	defer dbpool.Close()

	// 2. RabbitMQ Connection
	rabbitMQURL := os.Getenv("RABBITMQ_URL")
	if rabbitMQURL == "" {
		rabbitMQURL = "amqp://guest:guest@localhost:5672/"
	}
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

	ch, err := mqConn.Channel()
	if err != nil {
		log.Fatalf("Unable to open channel: %v\n", err)
	}
	defer ch.Close()

	// Set QoS to pull 1 job at a time per worker instance
	err = ch.Qos(1, 0, false)
	if err != nil {
		log.Fatalf("Failed to set QoS: %v\n", err)
	}

	msgs, err := ch.Consume(
		"assessment_submissions", // queue
		"",                       // consumer tag
		false,                    // auto-ack (FALSE: manual ACK after successful DB write)
		false,                    // exclusive
		false,
		false,
		nil,
	)
	if err != nil {
		log.Fatalf("Failed to register consumer: %v\n", err)
	}

	log.Println("Grading Worker initialized. Awaiting submissions...")

	forever := make(chan bool)

	go func() {
		for d := range msgs {
			var event AssessmentSubmittedEvent
			if err := json.Unmarshal(d.Body, &event); err != nil {
				log.Printf("Malformed message payload: %v", err)
				d.Nack(false, false) // Drop poison pill message
				continue
			}

			log.Printf("Evaluating submission instance=%s session=%s", event.InstanceID, event.SessionID)

			if err := evaluateSubmission(ctx, dbpool, event); err != nil {
				log.Printf("Evaluation failed: %v", err)
				d.Nack(false, true) // Requeue for retry
				continue
			}

			d.Ack(false) // Positively acknowledge message
			log.Printf("Successfully graded submission")
		}
	}()

	<-forever
}

func evaluateSubmission(ctx context.Context, db *pgxpool.Pool, event AssessmentSubmittedEvent) error {
	if event.SessionID != "" {
		var total, max float64
		err := db.QueryRow(ctx, `
			SELECT COALESCE(SUM(CASE
				WHEN key.q_type='MCQ' AND ans.selected_option_ids IS NOT NULL
					AND cardinality(key.expected_option_ids)>0
					AND ans.selected_option_ids <@ key.expected_option_ids
				THEN q.marks::numeric * cardinality(ans.selected_option_ids)::numeric / cardinality(key.expected_option_ids)
				WHEN key.q_type='FIB' AND CASE WHEN key.case_sensitive THEN BTRIM(COALESCE(ans.typed_response,''))=BTRIM(key.expected_text)
				  ELSE LOWER(BTRIM(COALESCE(ans.typed_response,'')))=LOWER(BTRIM(key.expected_text)) END
				THEN q.marks::numeric ELSE 0 END),0), COALESCE(SUM(q.marks::numeric),0)
			FROM candidate_sessions cs
			JOIN paper_questions pq ON pq.paper_id=cs.paper_id
			JOIN questions q ON q.id=pq.question_id
			LEFT JOIN candidate_session_answers ans ON ans.session_id=cs.id AND ans.question_id=q.id
			LEFT JOIN answer_vault.secure_answer_keys key ON key.question_id=q.id
			WHERE cs.id=$1`, event.SessionID).Scan(&total, &max)
		if err != nil {
			return err
		}
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `INSERT INTO candidate_session_results(session_id,score_obtained,max_score) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET score_obtained=EXCLUDED.score_obtained,max_score=EXCLUDED.max_score,evaluated_at=NOW()`, event.SessionID, total, max); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE candidate_sessions SET status='EVALUATED' WHERE id=$1`, event.SessionID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	var total, max float64
	err := db.QueryRow(ctx, `SELECT COALESCE(SUM(CASE WHEN key.q_type='MCQ' AND ca.selected_option_ids IS NOT NULL AND cardinality(key.expected_option_ids)>0 AND ca.selected_option_ids <@ key.expected_option_ids THEN q.marks::numeric * cardinality(ca.selected_option_ids)::numeric / cardinality(key.expected_option_ids) WHEN key.q_type='FIB' AND CASE WHEN key.case_sensitive THEN BTRIM(COALESCE(ca.typed_response,''))=BTRIM(key.expected_text) ELSE LOWER(BTRIM(COALESCE(ca.typed_response,'')))=LOWER(BTRIM(key.expected_text)) END THEN q.marks::numeric ELSE 0 END),0),COALESCE(SUM(q.marks::numeric),0) FROM candidate_assessment_instances i JOIN instance_questions iq ON iq.instance_id=i.id JOIN questions q ON q.id=iq.question_id LEFT JOIN candidate_answers ca ON ca.instance_id=i.id AND ca.question_id=q.id LEFT JOIN answer_vault.secure_answer_keys key ON key.question_id=q.id WHERE i.id=$1`, event.InstanceID).Scan(&total, &max)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, `INSERT INTO candidate_results(instance_id,total_score,max_score) VALUES($1,$2,$3) ON CONFLICT(instance_id) DO UPDATE SET total_score=EXCLUDED.total_score,max_score=EXCLUDED.max_score,evaluated_at=NOW()`, event.InstanceID, total, max)
	return err
}
