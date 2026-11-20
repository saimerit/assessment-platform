[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$review = Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json') -Raw | ConvertFrom-Json
if ($review.suffix -notmatch '^[a-f0-9]{12}$' -or $review.postgres -ne "assessment-auth-test-pg-$($review.suffix)") { throw 'Invalid isolated review environment.' }
$fixtures = Get-Content -LiteralPath (Join-Path $review.directory 'fixtures.json') -Raw | ConvertFrom-Json
foreach ($id in @($fixtures.candidate_id, $fixtures.session_id)) { if ($id -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid source fixture identifier.' } }
$reviewStudentId = [guid]::NewGuid().ToString()
$reviewSessionId = [guid]::NewGuid().ToString()
$reviewInvitation = 'renewal-' + [guid]::NewGuid().ToString('N')
$reviewEmail = "$reviewInvitation@attempt-access.test"
$fixtureSQL = @"
BEGIN;
INSERT INTO users(id,org_id,email,password_hash,full_name,role,registration_status)
SELECT '$reviewStudentId',org_id,'$reviewEmail',password_hash,'Elapsed renewal review','CANDIDATE','REGISTERED'
FROM users WHERE id='$($fixtures.candidate_id)';
INSERT INTO candidate_sessions(id,assessment_id,paper_id,student_id,invitation_token)
SELECT '$reviewSessionId',assessment_id,paper_id,'$reviewStudentId','$reviewInvitation'
FROM candidate_sessions WHERE id='$($fixtures.session_id)';
COMMIT;
"@
docker exec $review.postgres psql -U root -d assessment_attempt_auth_test -v ON_ERROR_STOP=1 -c $fixtureSQL | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not create the separate renewal review candidate.' }
$fixtures.candidate_a = $reviewEmail
$fixtures.candidate_id = $reviewStudentId
$fixtures.session_id = $reviewSessionId
$fixtures.event_invitation = $reviewInvitation
$fixtures | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $review.directory 'renewal-fixtures.json')
$rendererScript = '"' + (Join-Path $PSScriptRoot 'check-attempt-review-renderer.cjs') + '"'
$stdoutPath = Join-Path $review.directory 'renewal.stdout.log'
$stderrPath = Join-Path $review.directory 'renewal.stderr.log'
Write-Output "Starting real 16-minute native renderer renewal check for review session $reviewSessionId. No visible lockdown window is opened."
$rendererProcess = Start-Process -FilePath (Join-Path $repoRoot 'lockdown-client\node_modules\electron\dist\electron.exe') -ArgumentList @($rendererScript, '--renewal') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru -Wait
Get-Content -LiteralPath $stdoutPath
if ($rendererProcess.ExitCode -ne 0) { Get-Content -LiteralPath $stderrPath; throw 'Elapsed native renderer renewal check failed.' }
$persisted = docker exec $review.postgres psql -U root -d assessment_attempt_auth_test -t -A -c "SELECT status || '|' || (SELECT COUNT(*) FROM candidate_session_answers WHERE session_id='$reviewSessionId') FROM candidate_sessions WHERE id='$reviewSessionId';"
if ($LASTEXITCODE -ne 0 -or $persisted.Trim() -ne 'SUBMITTED|2') { throw 'Elapsed review submission state or answers were not persisted as expected.' }
Write-Output 'PASS: elapsed review submission and both answers are persisted in PostgreSQL.'
