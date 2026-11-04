-- Organization-specific candidate registration fields returned by the exam gateway.
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS candidate_intake_config JSONB NOT NULL DEFAULT '[
  {"key":"full_name","label":"Full name","type":"text","required":true},
  {"key":"email","label":"Email address","type":"email","required":true},
  {"key":"candidate_id","label":"Candidate ID","type":"text","required":false}
]'::jsonb;
