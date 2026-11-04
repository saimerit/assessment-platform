package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"log"
	"math/rand"
	"os"

	"github.com/jackc/pgx/v5"
)

type BlueprintRule struct {
	TopicID       string
	Difficulty    string
	QuestionCount int
}

func main() {
	ctx := context.Background()
	connStr := os.Getenv("ASSESSMENT_DATABASE_URL")
	if connStr == "" {
		connStr = "postgres://assessment_app:assessment_app_dev_password@localhost:5433/assessment_db?sslmode=disable"
	}
	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v\n", err)
	}
	defer conn.Close(ctx)

	blueprintID := "ffffffff-1111-2222-3333-444444444444"
	student1 := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	student2 := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

	fmt.Println("--- Generating Question Paper for Student 1 ---")
	qp1, err := GenerateQuestionPaper(ctx, conn, blueprintID, student1)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Student 1 Questions: %v\n\n", qp1)

	fmt.Println("--- Generating Question Paper for Student 2 ---")
	qp2, err := GenerateQuestionPaper(ctx, conn, blueprintID, student2)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Student 2 Questions: %v\n\n", qp2)
}

func GenerateQuestionPaper(ctx context.Context, conn *pgx.Conn, blueprintID string, studentID string) ([]string, error) {
	// 1. Fetch Blueprint Rules
	rows, err := conn.Query(ctx, `
		SELECT topic_id, difficulty, question_count 
		FROM blueprint_rules 
		WHERE blueprint_id = $1`, blueprintID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rules []BlueprintRule
	for rows.Next() {
		var r BlueprintRule
		if err := rows.Scan(&r.TopicID, &r.Difficulty, &r.QuestionCount); err != nil {
			return nil, err
		}
		rules = append(rules, r)
	}

	// 2. Initialize Seeded RNG using Hash(BlueprintID + StudentID)
	seed := deriveSeed(blueprintID, studentID)
	rng := rand.New(rand.NewSource(seed))

	var finalQuestionIDs []string

	// 3. For each rule, fetch the candidate pool and select random subset
	for _, rule := range rules {
		qRows, err := conn.Query(ctx, `
			SELECT q.id 
			FROM questions q
			JOIN subcategories s ON q.subcategory_id = s.id
			WHERE s.topic_id = $1 AND q.difficulty = $2
			ORDER BY q.id ASC`, rule.TopicID, rule.Difficulty)
		if err != nil {
			return nil, err
		}

		var pool []string
		for qRows.Next() {
			var qID string
			if err := qRows.Scan(&qID); err != nil {
				qRows.Close()
				return nil, err
			}
			pool = append(pool, qID)
		}
		qRows.Close()

		if len(pool) < rule.QuestionCount {
			return nil, fmt.Errorf("insufficient questions in pool for topic %s: needed %d, have %d",
				rule.TopicID, rule.QuestionCount, len(pool))
		}

		// Shuffle pool using deterministic RNG (Fisher-Yates)
		rng.Shuffle(len(pool), func(i, j int) {
			pool[i], pool[j] = pool[j], pool[i]
		})

		// Select required count
		finalQuestionIDs = append(finalQuestionIDs, pool[:rule.QuestionCount]...)
	}

	// 4. Final shuffle to interleave topics so candidates don't get all OS questions first
	rng.Shuffle(len(finalQuestionIDs), func(i, j int) {
		finalQuestionIDs[i], finalQuestionIDs[j] = finalQuestionIDs[j], finalQuestionIDs[i]
	})

	return finalQuestionIDs, nil
}

// Derive a 64-bit seed from a cryptographic hash of the input IDs
func deriveSeed(blueprintID, studentID string) int64 {
	hasher := sha256.New()
	hasher.Write([]byte(blueprintID + ":" + studentID))
	hashBytes := hasher.Sum(nil)
	return int64(binary.BigEndian.Uint64(hashBytes[:8]))
}
