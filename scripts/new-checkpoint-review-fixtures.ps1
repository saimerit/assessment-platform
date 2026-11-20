[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$review = Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json') -Raw | ConvertFrom-Json
if ($review.postgres -notmatch '^assessment-auth-test-pg-[a-f0-9]{12}$') { throw 'Use an isolated review database.' }
$source = Get-Content -LiteralPath (Join-Path $review.directory 'fixtures.json') -Raw | ConvertFrom-Json
$candidate = [guid]::NewGuid().ToString(); $event = [guid]::NewGuid().ToString(); $paper = [guid]::NewGuid().ToString(); $session = [guid]::NewGuid().ToString()
$blueprint = [guid]::NewGuid().ToString(); $invitation = [guid]::NewGuid().ToString(); $instance = [guid]::NewGuid().ToString()
$suffix = [guid]::NewGuid().ToString('N').Substring(0,12)
$email = "recovery-$suffix@attempt-access.test"
$eventToken = "recovery-event-$suffix"; $legacyToken = "recovery-legacy-$suffix"
# Copy the known test-only password hash and paper content; never read credentials
# from any user environment. Every invocation creates distinct attempts.
$sql = @"
BEGIN;
INSERT INTO users(id,org_id,email,password_hash,full_name,role,registration_status)
SELECT '$candidate',org_id,'$email',password_hash,'Recovery review candidate','CANDIDATE','REGISTERED' FROM users WHERE id='$($source.candidate_id)';
INSERT INTO assessment_events(id,org_id,title,mode,scheduled_start,scheduled_end,duration_minutes)
SELECT '$event',org_id,'Answer saving and recovery review','OFFLINE_NORMAL',NOW()-interval '5 minutes',NOW()+interval '4 hours',60 FROM users WHERE id='$candidate';
INSERT INTO assessment_papers(id,assessment_id,paper_code,set_name) VALUES('$paper','$event','RECOVERY-$suffix','Review paper');
INSERT INTO paper_questions(paper_id,question_id,sort_order) SELECT '$paper',pq.question_id,pq.sort_order FROM candidate_sessions cs JOIN paper_questions pq ON pq.paper_id=cs.paper_id WHERE cs.id='$($source.session_id)';
INSERT INTO candidate_sessions(id,assessment_id,paper_id,student_id,invitation_token) VALUES('$session','$event','$paper','$candidate','$eventToken');
INSERT INTO assessment_blueprints(id,org_id,title,duration_minutes) SELECT '$blueprint',org_id,'Legacy recovery review',60 FROM users WHERE id='$candidate';
INSERT INTO assessment_invitations(id,blueprint_id,student_id,invitation_token,scheduled_start,scheduled_end,passcode_hash) VALUES('$invitation','$blueprint','$candidate','$legacyToken',NOW()-interval '5 minutes',NOW()+interval '4 hours','test-only');
INSERT INTO candidate_assessment_instances(id,blueprint_id,student_id,status) VALUES('$instance','$blueprint','$candidate','IN_PROGRESS');
INSERT INTO instance_questions(instance_id,question_id,display_order) SELECT '$instance',question_id,sort_order FROM paper_questions WHERE paper_id='$paper';
INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_text)
SELECT q.id,'FIB','My conflict response' FROM paper_questions pq JOIN questions q ON q.id=pq.question_id WHERE pq.paper_id='$paper' AND q.q_type='FIB' ON CONFLICT(question_id) DO NOTHING;
INSERT INTO answer_vault.secure_answer_keys(question_id,q_type,expected_option_id,expected_option_ids)
SELECT q.id,'MCQ',o.id,ARRAY[o.id] FROM paper_questions pq JOIN questions q ON q.id=pq.question_id JOIN LATERAL(SELECT id FROM mcq_options WHERE question_id=q.id ORDER BY display_order LIMIT 1)o ON true
WHERE pq.paper_id='$paper' AND q.q_type='MCQ' ON CONFLICT(question_id) DO NOTHING;
COMMIT;
"@
$sql | docker exec -i $review.postgres psql -U root -d assessment_attempt_auth_test -v ON_ERROR_STOP=1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not create checkpoint review fixtures.' }
docker exec $review.redis redis-cli SET "event_passcode:$event" 123456 EX 14400 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set test event code.' }
docker exec $review.redis redis-cli SET "passcode:$blueprint`:$candidate" 654321 EX 14400 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set test legacy code.' }
$fixtures = [ordered]@{ candidate_a=$email; password='TestPassword123!'; candidate_id=$candidate; event_id=$event; paper_id=$paper; session_id=$session; event_invitation=$eventToken; event_code='123456'; blueprint_id=$blueprint; legacy_invitation=$legacyToken; legacy_code='654321'; instance_id=$instance; created_at=[DateTime]::UtcNow.ToString('o') }
$fixtures | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $review.directory 'checkpoint-fixtures.json')
Write-Output "Fresh recovery fixtures: $email; $eventToken; $legacyToken"
