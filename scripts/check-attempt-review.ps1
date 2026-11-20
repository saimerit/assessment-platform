[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$review = Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json') -Raw | ConvertFrom-Json
$fixtures = Get-Content -LiteralPath (Join-Path $review.directory 'fixtures.json') -Raw | ConvertFrom-Json
$results = [Collections.Generic.List[object]]::new()

function Invoke-ReviewCase {
    param([string]$Name,[string]$Method,[string]$Endpoint,[int]$Expected,[string]$Token='',[object]$Body=$null)
    $arguments = @{Uri="$($review.gateway_url)/api$Endpoint"; Method=$Method; SkipHttpErrorCheck=$true; TimeoutSec=15}
    if ($Token) { $arguments.Headers=@{Authorization="Bearer $Token"} }
    if ($null -ne $Body) { $arguments.ContentType='application/json'; $arguments.Body=($Body | ConvertTo-Json -Depth 10 -Compress) }
    $response = Invoke-WebRequest @arguments
    if ([int]$response.StatusCode -ne $Expected) { throw "$Name failed: expected $Expected, got $($response.StatusCode): $($response.Content)" }
    $results.Add([ordered]@{test=$Name; expected_status=$Expected; actual_status=[int]$response.StatusCode; result='PASS'})
    Write-Host "PASS $Name (HTTP $Expected)"
    return ($response.Content | ConvertFrom-Json)
}

function Get-ReviewAccountToken {
    param([string]$Email)
    $login = Invoke-ReviewCase "Login $Email" POST /auth/login 200 -Body @{email=$Email;password=$fixtures.password}
    return $login.token
}

$sessionPath = "/exam/sessions/$($fixtures.session_id)"
foreach ($route in @(@('GET',"$sessionPath/questions"),@('POST',"$sessionPath/unlock"),@('POST',"$sessionPath/start"),@('POST',"$sessionPath/submit"),@('POST',"/assessments/$($fixtures.blueprint_id)/start"),@('POST',"/assessments/$($fixtures.blueprint_id)/submit"),@('POST','/proctor/incidents'))) {
    $null = Invoke-ReviewCase "Missing attempt credential: $($route[1])" $route[0] $route[1] 401 -Body @{}
}
$null = Invoke-ReviewCase 'Wrong password rejected' POST /auth/login 401 -Body @{email=$fixtures.candidate_a;password='incorrect'}
$a = Get-ReviewAccountToken $fixtures.candidate_a
$b = Get-ReviewAccountToken $fixtures.candidate_b
$c = Get-ReviewAccountToken $fixtures.candidate_c
$staff = Get-ReviewAccountToken $fixtures.staff
foreach ($identity in @(@('Other candidate',$b),@('Other organization',$c),@('Staff',$staff))) {
    $null = Invoke-ReviewCase "$($identity[0]) cannot exchange A's invitation" POST /exam/access 403 $identity[1] @{invitation_token=$fixtures.event_invitation}
}
$aAccess = Invoke-ReviewCase 'Assigned candidate gets check-in access' POST /exam/access 200 $a @{invitation_token=$fixtures.event_invitation}
$null = Invoke-ReviewCase 'Account JWT cannot start an attempt' POST "$sessionPath/start" 401 $a @{}
$null = Invoke-ReviewCase 'Check-in credential cannot start before unlock' POST "$sessionPath/start" 403 $aAccess.attempt_token @{}
$null = Invoke-ReviewCase 'Check-in credential cannot read questions' GET "$sessionPath/questions" 403 $aAccess.attempt_token
$null = Invoke-ReviewCase 'Wrong access code rejected' POST "$sessionPath/unlock" 403 $aAccess.attempt_token @{passcode='wrong-code'}
$gateway = Invoke-ReviewCase 'Event invitation gateway available' GET "/exg/$($fixtures.event_invitation)" 200
if ($gateway.min_client_version -ne '1.1.0' -or $gateway.started_at) { throw 'Unexpected event gateway version/timer before start.' }
$legacyGateway = Invoke-ReviewCase 'Legacy invitation gateway available' GET "/exg/$($fixtures.legacy_invitation)" 200
if ($legacyGateway.min_client_version -ne '1.1.0') { throw 'Legacy gateway did not enforce minimum client 1.1.0.' }

# Candidate B exercises start/submission. Candidate A remains fresh for UI review.
$bPath = "/exam/sessions/$($fixtures.other_session_id)"
$bAccess = Invoke-ReviewCase 'Candidate B gets own check-in access' POST /exam/access 200 $b @{invitation_token=$fixtures.other_invitation}
$bUnlocked = Invoke-ReviewCase 'Valid code unlocks candidate B' POST "$bPath/unlock" 200 $bAccess.attempt_token @{passcode=$fixtures.event_code}
$start = Invoke-ReviewCase 'Start begins server timer' POST "$bPath/start" 200 $bUnlocked.attempt_token @{}
$repeat = Invoke-ReviewCase 'Repeated start preserves timer' POST "$bPath/start" 200 $bUnlocked.attempt_token @{}
if ($start.started_at -ne $repeat.started_at -or $start.timer_expires_at -ne $repeat.timer_expires_at) { throw 'Repeated start changed the authoritative timer.' }
$paper = Invoke-ReviewCase 'Authorized candidate can load paper' GET "$bPath/questions" 200 $bUnlocked.attempt_token
if (@($paper.questions).Count -ne 2) { throw 'Expected the two-question review paper.' }
$null = Invoke-ReviewCase 'Candidate B cannot access A questions' GET "$sessionPath/questions" 403 $bUnlocked.attempt_token
$null = Invoke-ReviewCase 'Spoofed telemetry candidate rejected' POST /proctor/incidents 403 $bUnlocked.attempt_token @{student_id=$fixtures.candidate_id;violation_type='REVIEW_CHECK'}
$null = Invoke-ReviewCase 'Associated telemetry accepted' POST /proctor/incidents 201 $bUnlocked.attempt_token @{violation_type='REVIEW_CHECK'}
node (Join-Path $PSScriptRoot 'check-attempt-review-client.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Live desktop credential renewal check failed.' }
$results.Add([ordered]@{test='Expired credential automatic renewal against live API';result='PASS';method='deterministic expiry fault injection; not a 16-minute wall-clock test'})
$rendererScript = '"' + (Join-Path $PSScriptRoot 'check-attempt-review-renderer.cjs') + '"'
$rendererStdout = Join-Path $review.directory 'renderer.stdout.log'
$rendererStderr = Join-Path $review.directory 'renderer.stderr.log'
$rendererProcess = Start-Process -FilePath (Join-Path $repoRoot 'lockdown-client\node_modules\electron\dist\electron.exe') -ArgumentList $rendererScript -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $rendererStdout -RedirectStandardError $rendererStderr -PassThru -Wait
Get-Content -LiteralPath $rendererStdout
if ($rendererProcess.ExitCode -ne 0) { Get-Content -LiteralPath $rendererStderr; throw 'Native Electron renderer credential checks failed.' }
$rendererReport = Get-Content -LiteralPath (Join-Path $review.directory 'renderer-results.json') -Raw | ConvertFrom-Json
foreach ($rendererTest in $rendererReport.tests) { $results.Add($rendererTest) }
$answers = @($paper.questions | ForEach-Object {
    if ($_.question_type -eq 'FIB') { @{question_id=$_.question_id;typed_response='Command review answer'} }
    else { @{question_id=$_.question_id;selected_option_ids=@($_.options[0].id)} }
})
$null = Invoke-ReviewCase 'Filled submission is accepted with broker available' POST "$bPath/submit" 202 $bUnlocked.attempt_token @{answers=$answers}

$legacyPath = "/assessments/$($fixtures.blueprint_id)"
$legacyAccess = Invoke-ReviewCase 'Legacy invitation gets check-in scope' POST /exam/access 200 $a @{invitation_token=$fixtures.legacy_invitation}
$null = Invoke-ReviewCase 'Old legacy instance cannot bypass unlock' POST "$legacyPath/start" 403 $legacyAccess.attempt_token @{student_id=$fixtures.candidate_id}
$legacyUnlocked = Invoke-ReviewCase 'Valid legacy code verified' POST "$legacyPath/verify-passcode" 200 $legacyAccess.attempt_token @{passcode=$fixtures.legacy_code}
$null = Invoke-ReviewCase 'Legacy paper starts after verification' POST "$legacyPath/start" 200 $legacyUnlocked.attempt_token @{student_id=$fixtures.candidate_id}
docker exec $review.postgres psql -U root -d assessment_attempt_auth_test -v ON_ERROR_STOP=1 -c "UPDATE assessment_invitations SET unlocked_at=NULL WHERE invitation_token='test-legacy-invitation';" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restore the legacy review check-in state.' }
$report = [ordered]@{verified_at=[DateTime]::UtcNow.ToString('o');gateway_url=$review.gateway_url;tests=$results;visual_review='pending user observation';wall_clock_16_minute_review='pending'}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $review.directory 'command-results.json')
Write-Output "Completed $($results.Count) live checks. Candidate A is ready for visual review."
