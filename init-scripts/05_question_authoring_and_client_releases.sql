\connect assessment_db

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Existing installs already have the core authoring tables. Add the fields used
-- by organization-scoped authoring and client compatibility checks in place.
ALTER TABLE topics
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE assessment_blueprints
    ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS total_marks INT NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS min_client_version VARCHAR(32) NOT NULL DEFAULT '1.0.0';

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS question_type VARCHAR(30) NOT NULL DEFAULT 'MCQ';

CREATE TABLE IF NOT EXISTS client_releases (
    version VARCHAR(32) PRIMARY KEY,
    download_url TEXT NOT NULL,
    release_notes TEXT,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    released_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_client_releases_released_at
    ON client_releases (released_at DESC);

INSERT INTO client_releases (version, download_url, release_notes, is_mandatory)
VALUES (
    '1.0.0',
    'https://releases.assessmentplatform.internal/AssessmentLockdownClient-1.0.0.exe',
    'Initial Secure Client Release',
    TRUE
)
ON CONFLICT (version) DO NOTHING;
