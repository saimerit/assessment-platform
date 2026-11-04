\connect assessment_db

ALTER TABLE assessment_events
    ADD COLUMN IF NOT EXISTS paper_assignment_mode VARCHAR(32) NOT NULL DEFAULT 'FIXED_SETS';
ALTER TABLE assessment_events
    ADD COLUMN IF NOT EXISTS random_set_count INT NOT NULL DEFAULT 0;

ALTER TABLE candidate_sessions
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS assessment_paper_generation_rules (
    assessment_id UUID NOT NULL REFERENCES assessment_events(id) ON DELETE CASCADE,
    section_order INT NOT NULL CHECK (section_order > 0),
    bank_id UUID NOT NULL REFERENCES question_banks(id) ON DELETE RESTRICT,
    section_name VARCHAR(255) NOT NULL,
    question_count INT NOT NULL CHECK (question_count > 0),
    PRIMARY KEY (assessment_id, section_order)
);

CREATE INDEX IF NOT EXISTS idx_paper_generation_rules_bank
    ON assessment_paper_generation_rules (assessment_id, bank_id);
