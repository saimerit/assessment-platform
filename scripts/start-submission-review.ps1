[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$manifest=Join-Path $repoRoot '.attempt-access-review\latest.json'
if(-not(Test-Path -LiteralPath $manifest)){throw 'Run scripts/start-attempt-review.ps1 to create the isolated base environment first'}
$review=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if($review.network -notmatch '^assessment-auth-review-[a-f0-9]{12}$' -or $review.postgres -notmatch '^assessment-auth-test-pg-[a-f0-9]{12}$'){throw 'Unexpected review targets'}
function Run-Docker {param([string[]]$Arguments);& docker @Arguments;if($LASTEXITCODE -ne 0){throw "Review Docker operation failed: $($Arguments[0])"}}
# Docker Desktop restart can leave disposable review containers stopped.
foreach($target in @($review.postgres,$review.redis)){Run-Docker -Arguments @('start',$target) | Out-Null}
$databaseReady=$false
for($attempt=0;$attempt -lt 60;$attempt++){docker exec $review.postgres pg_isready -U root -d assessment_attempt_auth_test *> $null;if($LASTEXITCODE -eq 0){$databaseReady=$true;break};Start-Sleep -Milliseconds 500}
if(-not $databaseReady){throw 'Review database did not resume'}
foreach($target in @("$($review.network)-portal","$($review.network)-gateway")){docker inspect $target *> $null;if($LASTEXITCODE -eq 0){Run-Docker -Arguments @('start',$target) | Out-Null}}
$gatewayPort=((docker port "$($review.network)-gateway" '80/tcp') -split ':')[-1].Trim()
if($LASTEXITCODE -ne 0 -or $gatewayPort -notmatch '^\d+$'){throw 'Review gateway port could not be resolved'}
$review.gateway_url="http://127.0.0.1:$gatewayPort"
$broker="$($review.network)-submission-rabbit"
$grader="$($review.network)-submission-grader"
$api="$($review.network)-api"
$apiImage="assessment-auth-review-api:$($review.suffix)-1c-final"
$graderImage="assessment-auth-review-grader:$($review.suffix)-1c"
$migration=(Get-Content -LiteralPath (Join-Path $repoRoot 'init-scripts\12_submission_delivery.sql') -Raw).Replace('\connect assessment_db','\connect assessment_attempt_auth_test')
$migration | docker exec -i $review.postgres psql -U root -d assessment_attempt_auth_test -v ON_ERROR_STOP=1 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Review migration 12 failed'}
$migration=(Get-Content -LiteralPath (Join-Path $repoRoot 'init-scripts\13_worker_recovery.sql') -Raw).Replace('\connect assessment_db','\connect assessment_attempt_auth_test')
$migration | docker exec -i $review.postgres psql -U root -d assessment_attempt_auth_test -v ON_ERROR_STOP=1 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Review migration 13 failed'}
if(-not $SkipBuild){
 Run-Docker -Arguments @('build','-t',$apiImage,(Join-Path $repoRoot 'assessment-api'))
 Run-Docker -Arguments @('build','-f',(Join-Path $repoRoot 'grading-worker\Dockerfile'),'-t',$graderImage,$repoRoot)
}else{foreach($image in @($apiImage,$graderImage)){Run-Docker -Arguments @('image','inspect',$image) | Out-Null}}
docker inspect $broker *> $null
if($LASTEXITCODE -ne 0){Run-Docker -Arguments @('run','-d','--name',$broker,'--network',$review.network,'rabbitmq:3-management-alpine') | Out-Null}
Run-Docker -Arguments @('start',$broker) | Out-Null
docker inspect $grader *> $null
if($LASTEXITCODE -eq 0){Run-Docker -Arguments @('rm','-f',$grader) | Out-Null}
docker inspect $api *> $null
if($LASTEXITCODE -eq 0){Run-Docker -Arguments @('rm','-f',$api) | Out-Null}
Run-Docker -Arguments @('run','-d','--name',$api,'--network',$review.network,'--network-alias','api','-e','ASSESSMENT_API_PORT=8080',
 '-e',"ASSESSMENT_DATABASE_URL=postgres://assessment_app:test-app-password@$($review.postgres):5432/assessment_attempt_auth_test?sslmode=disable",
 '-e',"REDIS_URL=redis://$($review.redis):6379/0",'-e',"RABBITMQ_URL=amqp://guest:guest@$broker`:5672/",
 '-e','JWT_SECRET=review-only-secret-with-at-least-32-characters','-e',"PUBLIC_APP_URL=$($review.gateway_url)",'-e',"CLIENT_RELEASE_URL=$($review.gateway_url)/downloads/review-client.exe",$apiImage) | Out-Null
for($attempt=0;$attempt -lt 60;$attempt++){docker exec $api wget -q -O - http://127.0.0.1:8080/healthz *> $null;if($LASTEXITCODE -eq 0){break};Start-Sleep -Milliseconds 250}
Run-Docker -Arguments @('run','-d','--name',$grader,'--network',$review.network,'-e',"GRADING_DATABASE_URL=postgres://assessment_grader:test-grader-password@$($review.postgres):5432/assessment_attempt_auth_test?sslmode=disable",'-e',"RABBITMQ_URL=amqp://guest:guest@$broker`:5672/",$graderImage) | Out-Null
$review | Add-Member -NotePropertyName submission_broker -NotePropertyValue $broker -Force
$review | Add-Member -NotePropertyName grader_image -NotePropertyValue $graderImage -Force
$review.api_image=$apiImage
$review.containers=@($review.containers+$broker+$grader | Select-Object -Unique)
$review | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest
Write-Output "Submission review API ready: $($review.gateway_url). Only review containers were changed."
