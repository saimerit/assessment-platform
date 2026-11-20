package main

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"time"
)

func attemptNow(ctx context.Context, db attemptDB) (time.Time, error) {
	var now time.Time
	err := db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now)
	return now.UTC(), err
}
func pinAttemptPaper(ctx context.Context, tx pgx.Tx, a attemptRecord, source string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT pin_attempt_paper($1,$2::uuid,$3::uuid,$4::uuid,$5)::text`, a.Kind, a.ID, a.OrgID, a.StudentID, source).Scan(&id)
	return id, err
}
func readAttemptPaper(ctx context.Context, db attemptDB, a attemptRecord) (json.RawMessage, error) {
	var content json.RawMessage
	err := db.QueryRow(ctx, `SELECT questions FROM attempt_paper_snapshots WHERE (session_id=$1::uuid AND $2='session') OR (invitation_id=$1::uuid AND $2='legacy')`, a.ID, a.Kind).Scan(&content)
	return content, err
}
