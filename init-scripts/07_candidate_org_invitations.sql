-- Organization membership invitations and candidate registration state.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS registration_status VARCHAR(24) NOT NULL DEFAULT 'REGISTERED';

-- Legacy exam-only invitations used sentinel values instead of a candidate-set password.
UPDATE users
SET registration_status = 'INVITED'
WHERE role = 'CANDIDATE'
  AND password_hash IN ('INVITED', 'TEMPORARY_ACCESS')
  AND registration_status <> 'INVITED';

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_registration_status_check'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_registration_status_check
            CHECK (registration_status IN ('INVITED', 'REGISTERED'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS organization_candidate_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    invitation_token VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(24) NOT NULL DEFAULT 'INVITED'
        CHECK (status IN ('INVITED', 'ACCEPTED', 'EXPIRED')),
    invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
    invited_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS idx_org_candidate_invites_org_status
    ON organization_candidate_invitations (org_id, status, invited_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON organization_candidate_invitations TO assessment_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO assessment_app;
