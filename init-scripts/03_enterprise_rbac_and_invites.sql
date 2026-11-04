-- init-scripts/03_enterprise_rbac_and_invites.sql

-- 1. Organizations (Multi-tenant structure)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    org_type VARCHAR(64) NOT NULL DEFAULT 'ENTERPRISE', -- 'ENTERPRISE' (OA/Hiring) or 'ACADEMIC' (University/School)
    domain VARCHAR(128) UNIQUE,                         -- e.g. 'uber.com', 'mit.edu'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Extended User Roles Enum
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM (
        'SUPER_ADMIN',
        'ORG_ADMIN',
        'INSTRUCTOR_RECRUITER',
        'INVIGILATOR_PROCTOR',
        'CANDIDATE'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. Unified Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'CANDIDATE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Replace sections 4, 5, 6, and 7 with:

-- 4. Extend Blueprints
ALTER TABLE assessment_blueprints 
ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS assessment_type VARCHAR(64) DEFAULT 'ONLINE_ASSESSMENT';

-- 5. Proctor Assignment
CREATE TABLE IF NOT EXISTS assessment_proctor_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blueprint_id UUID NOT NULL REFERENCES assessment_blueprints(id) ON DELETE CASCADE,
    proctor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_or_tag VARCHAR(128) DEFAULT 'ALL',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_proctor_slot UNIQUE (blueprint_id, proctor_id, room_or_tag)
);

-- 6. Candidate Invitations
CREATE TABLE IF NOT EXISTS assessment_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blueprint_id UUID NOT NULL REFERENCES assessment_blueprints(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitation_token VARCHAR(64) UNIQUE NOT NULL,
    scheduled_start TIMESTAMP WITH TIME ZONE NOT NULL,
    scheduled_end TIMESTAMP WITH TIME ZONE NOT NULL,
    passcode_hash VARCHAR(255) NOT NULL,
    status VARCHAR(32) DEFAULT 'INVITED',
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_student_blueprint UNIQUE (blueprint_id, student_id)
);

-- 7. Live Proctoring Incident Logging
CREATE TABLE IF NOT EXISTS proctoring_incident_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blueprint_id UUID NOT NULL REFERENCES assessment_blueprints(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_by VARCHAR(32) NOT NULL,
    violation_type VARCHAR(64) NOT NULL,
    evidence_payload JSONB,
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Seed Default Enterprise Organization
INSERT INTO organizations (id, name, org_type, domain)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'Acme Corp Screening',
    'ENTERPRISE',
    'acmecorp.com'
) ON CONFLICT (id) DO NOTHING;

-- 9. Seed Users Across All Roles (Passwords hashed with standard bcrypt cost 10 for: "Password123!")
INSERT INTO users (id, org_id, email, password_hash, full_name, role)
VALUES 
(
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'admin@acmecorp.com',
    '$2a$10$7R64sQvX.d8d75Llh3hI7.aO0y5ElnOqTjAupZk9N7P2q0P4Rlyy2',
    'Corp Admin',
    'ORG_ADMIN'
),
(
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'recruiter@acmecorp.com',
    '$2a$10$7R64sQvX.d8d75Llh3hI7.aO0y5ElnOqTjAupZk9N7P2q0P4Rlyy2',
    'Tech Recruiter',
    'INSTRUCTOR_RECRUITER'
),
(
    '44444444-4444-4444-4444-444444444444',
    '11111111-1111-1111-1111-111111111111',
    'proctor@acmecorp.com',
    '$2a$10$7R64sQvX.d8d75Llh3hI7.aO0y5ElnOqTjAupZk9N7P2q0P4Rlyy2',
    'Exam Invigilator',
    'INVIGILATOR_PROCTOR'
),
(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    'candidate@example.com',
    '$2a$10$7R64sQvX.d8d75Llh3hI7.aO0y5ElnOqTjAupZk9N7P2q0P4Rlyy2',
    'Screening Candidate',
    'CANDIDATE'
)
ON CONFLICT (email) DO NOTHING;