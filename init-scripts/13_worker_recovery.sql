\connect assessment_db
BEGIN;
CREATE TABLE IF NOT EXISTS worker_jobs (
 queue_name TEXT NOT NULL, job_id TEXT NOT NULL,
 body_hash TEXT NOT NULL, attempts INT NOT NULL DEFAULT 0 CHECK(attempts>=0),
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','RETRYING','SUCCEEDED','DEAD_LETTER_PENDING','DEAD_LETTER')),
 enqueued_at TIMESTAMPTZ NOT NULL, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 lease_until TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
 last_error_code TEXT,
 PRIMARY KEY(queue_name,job_id)
);
CREATE INDEX IF NOT EXISTS worker_jobs_outstanding ON worker_jobs(queue_name,enqueued_at)
 WHERE state NOT IN ('SUCCEEDED','DEAD_LETTER');
REVOKE ALL ON worker_jobs FROM PUBLIC,assessment_app,assessment_grader;
GRANT SELECT,INSERT,UPDATE ON worker_jobs TO assessment_app,assessment_grader;
CREATE TABLE IF NOT EXISTS notification_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), job_id TEXT NOT NULL, attempt INT NOT NULL,
 recipient_email TEXT NOT NULL, template_type TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('SENT','FAILED','MOCK_SENT')),
 error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(job_id,attempt)
);
REVOKE ALL ON notification_logs FROM PUBLIC,assessment_app,assessment_grader;
GRANT SELECT,INSERT ON notification_logs TO assessment_app;
COMMIT;
