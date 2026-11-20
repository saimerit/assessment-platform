\connect assessment_db

BEGIN;
ALTER TABLE candidate_sessions ADD COLUMN IF NOT EXISTS timer_expires_at TIMESTAMPTZ;
UPDATE candidate_sessions cs SET timer_expires_at=cs.started_at + e.duration_minutes * interval '1 minute'
FROM assessment_events e WHERE e.id=cs.assessment_id AND cs.started_at IS NOT NULL AND cs.timer_expires_at IS NULL;
ALTER TABLE candidate_assessment_instances ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE candidate_assessment_instances ADD COLUMN IF NOT EXISTS timer_expires_at TIMESTAMPTZ;
-- Old legacy attempts never stored a timer. Use their original instance creation
-- time conservatively; migration/restart must not grant a fresh duration.
UPDATE candidate_assessment_instances ai SET started_at=ai.created_at,
timer_expires_at=ai.created_at + b.duration_minutes * interval '1 minute'
FROM assessment_blueprints b WHERE b.id=ai.blueprint_id AND ai.status='IN_PROGRESS' AND ai.started_at IS NULL;
ALTER TABLE candidate_answers ADD COLUMN IF NOT EXISTS flagged_for_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE candidate_session_answers ADD COLUMN IF NOT EXISTS flagged_for_review BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS attempt_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID UNIQUE REFERENCES candidate_sessions(id) ON DELETE CASCADE,
    invitation_id UUID UNIQUE REFERENCES assessment_invitations(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    last_question_id UUID REFERENCES questions(id) ON DELETE SET NULL,
    active_view TEXT NOT NULL DEFAULT 'home' CHECK (active_view IN ('home','question')),
    saved_at TIMESTAMPTZ,
    CHECK (num_nonnulls(session_id,invitation_id)=1)
);
CREATE TABLE IF NOT EXISTS attempt_checkpoint_updates (
    checkpoint_id UUID NOT NULL REFERENCES attempt_checkpoints(id) ON DELETE CASCADE,
    update_id UUID NOT NULL,
    fingerprint TEXT NOT NULL,
    revision BIGINT NOT NULL,
    PRIMARY KEY (checkpoint_id,update_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON attempt_checkpoints,attempt_checkpoint_updates TO assessment_app;
COMMIT;
