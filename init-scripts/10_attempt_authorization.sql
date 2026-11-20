\connect assessment_db

BEGIN;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='candidate_sessions' AND column_name='unlocked_at') THEN
        ALTER TABLE candidate_sessions ADD COLUMN unlocked_at TIMESTAMPTZ;
        -- Event sessions previously reached IN_PROGRESS only after verification.
        UPDATE candidate_sessions SET unlocked_at=COALESCE(started_at, created_at)
        WHERE status='IN_PROGRESS';
    END IF;
END $$;
ALTER TABLE assessment_invitations ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMPTZ;
-- Legacy instances had a start bypass and must verify their passcode again.
COMMIT;
