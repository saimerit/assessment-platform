\connect assessment_db
\getenv assessment_app_password ASSESSMENT_APP_DB_PASSWORD
\getenv assessment_grader_password ASSESSMENT_GRADER_DB_PASSWORD

-- One organization admin, multiple proctors, organization-owned question banks.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS admin_id UUID;
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS org_type VARCHAR(64) NOT NULL DEFAULT 'ENTERPRISE';
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_admin_id_fkey') THEN
        ALTER TABLE organizations ADD CONSTRAINT organizations_admin_id_fkey
            FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_org_admin
    ON users (org_id) WHERE role = 'ORG_ADMIN';
UPDATE organizations o SET admin_id = u.id
FROM users u
WHERE u.org_id = o.id AND u.role = 'ORG_ADMIN' AND o.admin_id IS NULL;

CREATE TABLE IF NOT EXISTS question_banks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_banks_org_name
    ON question_banks (org_id, lower(name));

-- Extend the existing question bank without replacing legacy blueprint questions.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS bank_id UUID REFERENCES question_banks(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS q_type VARCHAR(8) NOT NULL DEFAULT 'MCQ';
ALTER TABLE questions ALTER COLUMN subcategory_id DROP NOT NULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_q_type_check') THEN
        ALTER TABLE questions ADD CONSTRAINT questions_q_type_check CHECK (q_type IN ('MCQ', 'FIB'));
    END IF;
END $$;

ALTER TABLE mcq_options ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 1;
WITH ordered_options AS (
    SELECT id, row_number() OVER (PARTITION BY question_id ORDER BY id)::INT AS position
    FROM mcq_options
)
UPDATE mcq_options mo SET display_order = ordered_options.position
FROM ordered_options
WHERE mo.id = ordered_options.id AND mo.display_order <> ordered_options.position;

-- Move existing correct-option data into the worker-only vault before removing it
-- from the application-facing option table.
CREATE SCHEMA IF NOT EXISTS answer_vault;
CREATE TABLE IF NOT EXISTS answer_vault.secure_answer_keys (
    question_id UUID PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
    q_type VARCHAR(8) NOT NULL CHECK (q_type IN ('MCQ', 'FIB')),
    expected_option_id UUID REFERENCES mcq_options(id) ON DELETE SET NULL,
    expected_text TEXT,
    case_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
    CHECK (
        (q_type = 'MCQ' AND expected_option_id IS NOT NULL AND expected_text IS NULL)
        OR (q_type = 'FIB' AND expected_option_id IS NULL AND expected_text IS NOT NULL)
    )
);
ALTER TABLE answer_vault.secure_answer_keys ADD COLUMN IF NOT EXISTS expected_option_ids UUID[];
UPDATE answer_vault.secure_answer_keys
SET expected_option_ids = ARRAY[expected_option_id]
WHERE q_type = 'MCQ' AND expected_option_ids IS NULL AND expected_option_id IS NOT NULL;
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'mcq_options' AND column_name = 'is_correct'
    ) THEN
        INSERT INTO answer_vault.secure_answer_keys (question_id, q_type, expected_option_id, expected_option_ids)
        SELECT DISTINCT ON (q.id) q.id, 'MCQ', mo.id, ARRAY[mo.id]
        FROM questions q
        JOIN mcq_options mo ON mo.question_id = q.id AND mo.is_correct
        WHERE q.q_type = 'MCQ'
        ON CONFLICT (question_id) DO NOTHING;
        ALTER TABLE mcq_options DROP COLUMN is_correct;
    END IF;
END $$;

-- Events are scheduled instances of an assessment. A single event can have
-- several papers and any number of assigned proctors.
CREATE TABLE IF NOT EXISTS assessment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    mode VARCHAR(32) NOT NULL DEFAULT 'ONLINE_PROCTORING'
        CHECK (mode IN ('ONLINE_PROCTORING', 'OFFLINE_NORMAL', 'OFFLINE_PROCTORING')),
    scheduled_start TIMESTAMPTZ NOT NULL,
    scheduled_end TIMESTAMPTZ NOT NULL,
    duration_minutes INT NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (scheduled_end > scheduled_start)
);

CREATE TABLE IF NOT EXISTS assessment_proctors (
    assessment_id UUID NOT NULL REFERENCES assessment_events(id) ON DELETE CASCADE,
    proctor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_or_group VARCHAR(64) NOT NULL DEFAULT 'MAIN',
    passcode_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (assessment_id, proctor_id)
);

CREATE TABLE IF NOT EXISTS assessment_papers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessment_events(id) ON DELETE CASCADE,
    paper_code VARCHAR(32) NOT NULL,
    set_name VARCHAR(64) NOT NULL DEFAULT 'SET-A',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (assessment_id, paper_code),
    UNIQUE (assessment_id, set_name)
);

CREATE TABLE IF NOT EXISTS paper_questions (
    paper_id UUID NOT NULL REFERENCES assessment_papers(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    sort_order INT NOT NULL CHECK (sort_order > 0),
    PRIMARY KEY (paper_id, question_id),
    UNIQUE (paper_id, sort_order)
);

CREATE TABLE IF NOT EXISTS candidate_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessment_events(id) ON DELETE CASCADE,
    paper_id UUID NOT NULL REFERENCES assessment_papers(id) ON DELETE RESTRICT,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitation_token VARCHAR(64) UNIQUE NOT NULL,
    assigned_proctor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'INVITED'
        CHECK (status IN ('INVITED', 'IN_PROGRESS', 'SUBMITTED', 'EVALUATED', 'EXPIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (assessment_id, student_id)
);

CREATE TABLE IF NOT EXISTS candidate_session_answers (
    session_id UUID NOT NULL REFERENCES candidate_sessions(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    selected_option_id UUID REFERENCES mcq_options(id) ON DELETE RESTRICT,
    typed_response TEXT,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, question_id),
    CHECK (selected_option_id IS NULL OR typed_response IS NULL)
);
ALTER TABLE candidate_session_answers ADD COLUMN IF NOT EXISTS selected_option_ids UUID[];
UPDATE candidate_session_answers
SET selected_option_ids = ARRAY[selected_option_id]
WHERE selected_option_ids IS NULL AND selected_option_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS assessment_event_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL REFERENCES assessment_events(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_by VARCHAR(32) NOT NULL,
    violation_type VARCHAR(64) NOT NULL,
    evidence_payload JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_event_incidents_assessment_time
    ON assessment_event_incidents (assessment_id, occurred_at DESC);

ALTER TABLE candidate_answers ADD COLUMN IF NOT EXISTS typed_response TEXT;
ALTER TABLE candidate_answers ADD COLUMN IF NOT EXISTS selected_option_ids UUID[];
UPDATE candidate_answers
SET selected_option_ids = ARRAY[selected_option_id]
WHERE selected_option_ids IS NULL AND selected_option_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS candidate_results (
    instance_id UUID PRIMARY KEY REFERENCES candidate_assessment_instances(id) ON DELETE CASCADE,
    total_score INT NOT NULL DEFAULT 0,
    max_score INT NOT NULL DEFAULT 0,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE candidate_results ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES candidate_sessions(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_results_session
    ON candidate_results (session_id);
CREATE TABLE IF NOT EXISTS candidate_session_results (
    session_id UUID PRIMARY KEY REFERENCES candidate_sessions(id) ON DELETE CASCADE,
    score_obtained INT NOT NULL,
    max_score INT NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE candidate_results ALTER COLUMN total_score TYPE NUMERIC(10,2) USING total_score::NUMERIC(10,2);
ALTER TABLE candidate_results ALTER COLUMN max_score TYPE NUMERIC(10,2) USING max_score::NUMERIC(10,2);
ALTER TABLE candidate_session_results ALTER COLUMN score_obtained TYPE NUMERIC(10,2) USING score_obtained::NUMERIC(10,2);
ALTER TABLE candidate_session_results ALTER COLUMN max_score TYPE NUMERIC(10,2) USING max_score::NUMERIC(10,2);

-- Keep key material outside the public schema. The API may author keys but
-- cannot read them; only the grading login can SELECT them.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessment_app') THEN
        CREATE ROLE assessment_app LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessment_grader') THEN
        CREATE ROLE assessment_grader LOGIN;
    END IF;
END $$;
ALTER ROLE assessment_app PASSWORD :'assessment_app_password';
ALTER ROLE assessment_grader PASSWORD :'assessment_grader_password';

REVOKE ALL ON SCHEMA answer_vault FROM PUBLIC;
REVOKE ALL ON TABLE answer_vault.secure_answer_keys FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO assessment_app, assessment_grader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO assessment_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO assessment_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO assessment_grader;
GRANT INSERT, UPDATE ON candidate_results, candidate_session_results TO assessment_grader;
GRANT UPDATE ON candidate_assessment_instances, candidate_sessions TO assessment_grader;
GRANT USAGE ON SCHEMA answer_vault TO assessment_app, assessment_grader;
GRANT INSERT, UPDATE ON answer_vault.secure_answer_keys TO assessment_app;
GRANT SELECT ON answer_vault.secure_answer_keys TO assessment_grader;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE root IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO assessment_app;
ALTER DEFAULT PRIVILEGES FOR ROLE root IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO assessment_app;
ALTER DEFAULT PRIVILEGES FOR ROLE root IN SCHEMA public
    GRANT SELECT ON TABLES TO assessment_grader;

