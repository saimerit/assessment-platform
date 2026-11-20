[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'start-submission-review.ps1') -SkipBuild:$SkipBuild
$review=Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review/latest.json') -Raw | ConvertFrom-Json
if($review.network -notmatch '^assessment-auth-review-[a-f0-9]{12}$'){throw 'Requires isolated review targets'}
function Run-Docker {param([string[]]$Arguments);& docker @Arguments;if($LASTEXITCODE -ne 0){throw "Review Docker operation failed: $($Arguments[0])"}}
$notification="$($review.network)-notification-worker"
$grader="$($review.network)-submission-grader"
$sink="$($review.network)-smtp-sink"
$notificationImage="assessment-auth-review-notification:$($review.suffix)-1d"
$sinkImage="assessment-auth-review-smtp:$($review.suffix)"
function Available-Port {$listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$listener.Start();$number=$listener.LocalEndpoint.Port;$listener.Stop();return $number}
$smtpPort=Available-Port;$graderPort=Available-Port;$notificationPort=Available-Port
if(-not $SkipBuild){
 Run-Docker -Arguments @('build','-f',(Join-Path $repoRoot 'notification-worker/Dockerfile'),'-t',$notificationImage,$repoRoot)
 Run-Docker -Arguments @('build','-t',$sinkImage,(Join-Path $repoRoot 'ops/review-smtp'))
}else{foreach($image in @($notificationImage,$sinkImage)){Run-Docker -Arguments @('image','inspect',$image) | Out-Null}}
foreach($target in @($grader,$notification,$sink)) { docker inspect $target *> $null;if($LASTEXITCODE -eq 0){Run-Docker -Arguments @('rm','-f',$target) | Out-Null} }
Run-Docker -Arguments @('run','-d','--name',$sink,'--network',$review.network,'-p',"127.0.0.1:$smtpPort`:8080",$sinkImage) | Out-Null
$common=@('--network',$review.network,'-e',"RABBITMQ_URL=amqp://guest:guest@$($review.submission_broker):5672/",'-e',"RABBITMQ_MANAGEMENT_URL=http://$($review.submission_broker):15672",'-e','WORKER_MAX_ATTEMPTS=3','-e','WORKER_PROCESSING_TIMEOUT=1s','-e','WORKER_RETRY_DELAYS=2s,3s,4s','-e','WORKER_MONITOR_INTERVAL=500ms','-e','WORKER_QUEUE_AGE_WARNING=2s')
Run-Docker -Arguments (@('run','-d','--name',$grader,'-p',"127.0.0.1:$graderPort`:8091")+$common+@('-e',"GRADING_DATABASE_URL=postgres://assessment_grader:test-grader-password@$($review.postgres):5432/assessment_attempt_auth_test?sslmode=disable",$review.grader_image)) | Out-Null
Run-Docker -Arguments (@('run','-d','--name',$notification,'-p',"127.0.0.1:$notificationPort`:8091")+$common+@('-e',"ASSESSMENT_DATABASE_URL=postgres://assessment_app:test-app-password@$($review.postgres):5432/assessment_attempt_auth_test?sslmode=disable",'-e',"PUBLIC_APP_URL=$($review.gateway_url)",'-e',"SMTP_HOST=$sink",'-e','SMTP_PORT=2525','-e','SMTP_SENDER=review@worker-recovery.test','-e','SMTP_MODE=smtp',$notificationImage)) | Out-Null
function Target-Url {param([string]$Name,[string]$Port);$binding=((docker port $Name $Port) -split ':')[-1].Trim();if($LASTEXITCODE -ne 0){throw 'Could not resolve review binding'};return "http://127.0.0.1:$binding"}
$workerReview=@{grader=$grader;notification=$notification;smtp_sink=$sink;grader_url=(Target-Url $grader '8091/tcp');notification_url=(Target-Url $notification '8091/tcp');smtp_url=(Target-Url $sink '8080/tcp');created_at=[datetime]::UtcNow.ToString('o')}
$workerReview | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $review.directory 'worker-review.json')
$review.containers=@($review.containers+$notification+$sink | Select-Object -Unique)
$review | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review/latest.json')
foreach($target in @($workerReview.grader_url,$workerReview.notification_url)){
 $ready=$false
 for($attempt=0;$attempt -lt 80;$attempt++){try{if((Invoke-WebRequest "$target/readyz" -TimeoutSec 2).StatusCode -eq 200){$ready=$true;break}}catch{Start-Sleep -Milliseconds 250}}
 if(-not $ready){docker logs $grader --tail 15;docker logs $notification --tail 15;throw 'Review workers did not become ready'}
}
Write-Output "Worker review ready. Grader: $($workerReview.grader_url); notification: $($workerReview.notification_url). SMTP remains local."
