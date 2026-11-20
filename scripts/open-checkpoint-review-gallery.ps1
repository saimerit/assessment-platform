[CmdletBinding()]
param([ValidateSet('1B','1C','1D')][string]$Section='1B')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$review = Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json') -Raw | ConvertFrom-Json
$screens = @(
    @{ key='saved'; title='1. Saved answer'; check='Check the green Saved to server label, last save time, answer and review flag.' },
    @{ key='saving'; title='2. Saving'; check='Check the Saving label while the typed answer stays visible.' },
    @{ key='offline'; title='3. Disconnected save'; check='Check the offline warning and Retry sync button. The draft must remain readable.' },
    @{ key='error'; title='4. Save error'; check='Check the error and Retry sync action without covering the answer.' },
    @{ key='recovered'; title='5. Recovered progress'; check='Check the restored typed draft, flagged state, recovered message and continuing timer.' },
    @{ key='conflict'; title='6. Conflicting responses'; check='Check both response values, the question title and the two choices.' },
    @{ key='zoom'; title='7. At 200% zoom'; check='Check readable saving information and reachable Submit action with vertical scrolling.' }
)
$pageName='checkpoint-review.html'
$manifestName='checkpoint-gallery.json'
$logName='gallery'
$heading='Section 1B: answer saving and recovery'
$description='Built UI screenshots from command-driven tests against the isolated API. Desktop kiosk and hardware enforcement are test doubles. All shown answer values are synthetic. Estimated total: 12–18 minutes. Deployment remains deferred.'
if($Section -eq '1C') {
    $pageName='submission-review.html';$manifestName='submission-gallery.json';$logName='submission-gallery'
    $heading='Section 1C: submission, deadlines and receipts'
    $screens=@(
        @{key='pending';title='1. Unknown submission confirmation';check='Check that the pending message explains retained answers and that Retry confirmation is clear.';files=@('checkpoint-event-submission-pending.png')},
        @{key='receipt';title='2. Receipt and automatic close';check='Check the response count, submission time, receipt ID and one-minute close countdown. There are no grading controls or score details; Exit application is available immediately.';files=@('checkpoint-event-receipt-confirmed.png','checkpoint-event-receipt-countdown.png')},
        @{key='reopened';title='3. Receipt selection and reopen';check='Check that the selected ID is readable and the reopened receipt retains its details. Commands verified the full selection and unchanged identity.';files=@('checkpoint-event-receipt-selected.png','checkpoint-event-receipt-reopened.png')},
        @{key='deadline';title='4. Deadline confirmation';check='Check the time-ended pending message and the final receipt explanation. Only the one server-accepted response is counted; the unsent draft is excluded.';files=@('checkpoint-legacy-deadline-pending.png','checkpoint-legacy-deadline-receipt.png')},
        @{key='zoom';title='5. Narrow layout at 200% zoom';check='Compare the top and scrolled action views. Check readable labels, wrapping receipt ID and reachable actions in both models.';files=@('checkpoint-event-receipt-zoom-top.png','checkpoint-event-receipt-zoom.png','checkpoint-legacy-receipt-zoom-top.png','checkpoint-legacy-receipt-zoom.png')},
        @{key='gateway';title='6. Completed gateway and candidate portal';check='Check submitted status, receipt entry and matching theme. The candidate portal shows submission records without grading state or scores. The client version probe is simulated; actual archived-client detection remains open.';files=@('submission-gateway-receipt.png','submission-candidate-portal.png','submission-candidate-portal-records.png')}
    )
}
if($Section -eq '1D') {
    $pageName='worker-review.html';$manifestName='worker-gallery.json';$logName='worker-gallery';$heading='Section 1D: worker retry and recovery'
    $evidence=Get-Content -LiteralPath (Join-Path $review.directory 'worker-recovery-results.json') -Raw | ConvertFrom-Json
    if($evidence.passed -ne 8 -or $evidence.checks.Count -ne 8){throw 'Complete all eight live worker checks before opening the review'}
    $description='Recorded health from eight passing command tests against the isolated services. SMTP stayed local. The short test profile uses three attempts and a one-second processing deadline; production defaults are five attempts and 15 seconds. Ready consumers can still have dead-letter alerts requiring attention. Review estimate: 5–8 minutes. Deployment remains deferred.'
    function Encode([object]$value){return [System.Net.WebUtility]::HtmlEncode([string]$value)}
    function Health-Table([array]$Rows){
        $body=($Rows | ForEach-Object {
            $state=$_.state;$label=Encode $_.label
            $readyLabel=if($state.ready){'Ready'}else{'Not ready'}
            $readyClass=if($state.ready){'pass'}else{'attention'}
            $queueAge=if($null -eq $state.queue_age_seconds){'Unknown'}else{('{0:N1}s' -f [double]$state.queue_age_seconds)}
            $pendingAge=('{0:N1}s' -f [double]$state.oldest_pending_job_age_seconds)
            $alerts=if($state.alerts.Count){Encode ($state.alerts -join ', ')}else{'None'}
            "<tr><th scope='row'>$label<small>$(Encode $state.queue)</small></th><td><span class='$readyClass'>$readyLabel</span></td><td>$(Encode $state.ready_messages)</td><td>$(Encode $state.retry_messages)</td><td>$(Encode $state.dead_letter_messages)</td><td>$(Encode $state.leased_jobs)</td><td>$queueAge</td><td>$pendingAge</td><td>$(Encode $state.connections_total)</td><td>$alerts</td></tr>"
        }) -join "`n"
        return "<div class='table-scroll' tabindex='0' aria-label='Worker health comparison; scroll horizontally if needed'><table><thead><tr><th scope='col'>Snapshot</th><th scope='col'>Consumer</th><th scope='col'>Queued</th><th scope='col'>Retry</th><th scope='col'>Dead letters</th><th scope='col'>Leased</th><th scope='col'>Queue age</th><th scope='col'>Oldest outstanding</th><th scope='col'>Connections</th><th scope='col'>Alerts</th></tr></thead><tbody>$body</tbody></table></div>"
    }
    $screens=@(
        @{key='healthy';title='1. Healthy workers';check='Check clear worker names, Ready states and queue counts.';rows=@(@{label='Grading';state=$evidence.snapshots.healthy.grader},@{label='Notification';state=$evidence.snapshots.healthy.notification})},
        @{key='retry';title='2. Delayed retries and timeout';check='Check pending retries, leased work, age and alerts. Queue age and oldest outstanding job age describe different observations.';rows=@(@{label='After delivery failure';state=$evidence.snapshots.retry},@{label='Stalled SMTP';state=$evidence.snapshots.timeout})},
        @{key='reconnect';title='3. Disconnect and recovery';check='Check Not ready during the outage, Ready after recovery and increased connection counts. Both worker processes continued without a restart.';rows=@(@{label='Disconnected notification';state=$evidence.snapshots.disconnected},@{label='Recovered grading';state=$evidence.snapshots.recovered.grader},@{label='Recovered notification';state=$evidence.snapshots.recovered.notification})},
        @{key='dead';title='4. Dead-letter attention and evidence';check='Check the dead-letter alert remains visible while the consumer is Ready. No candidate scores, answers or message bodies are shown.';rows=@(@{label='Final notification state';state=$evidence.snapshots.final})}
    )
    $cards=($screens | ForEach-Object {"<section id='$($_.key)'><h2>$($_.title)</h2><p>$($_.check)</p>$(Health-Table $_.rows)</section>"}) -join "`n"
    $checks=($evidence.checks | ForEach-Object {"<li>$(Encode $_)</li>"}) -join "`n"
    $cards+="<section><h2>Eight command checks passed</h2><ol>$checks</ol><p><a href='worker-recovery-results.json' target='_blank' rel='noopener'>Open recorded evidence</a></p><p>These are captured, timestamped test observations. Disconnected snapshots retain last-known counters; current queue age may be unknown when management data is unavailable. External alert delivery and audited replay belong to the operations section.</p></section>"
} else {
$cards = ($screens | ForEach-Object {
    $screen=$_
    $files=if($screen.files){$screen.files}else{@("checkpoint-event-$($screen.key).png")}
    $images=($files | ForEach-Object {
        $file=$_
        if (-not (Test-Path -LiteralPath (Join-Path $review.directory $file))) { throw "Missing review screenshot: $file" }
        "<p><a href='$file' target='_blank'>Open full-size screenshot</a></p><img src='$file' alt='$($screen.title)' loading='lazy'>"
    }) -join "`n"
    "<section id='$($screen.key)'><h2>$($screen.title)</h2><p>$($screen.check)</p>$images</section>"
}) -join "`n"
}
$nav = ($screens | ForEach-Object { "<a href='#$($_.key)'>$($_.title)</a>" }) -join ' '
$html = @"
<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Section $Section review</title>
<style>body{margin:0;background:#f7f8fc;color:#26345c;font:15px 'Segoe UI',Arial,sans-serif}header,main{max-width:1300px;margin:auto;padding:24px}h1{font-size:27px}nav{display:flex;flex-wrap:wrap;gap:8px}a{color:#5267b1}nav a{background:#fff;border:1px solid #dce2ef;border-radius:8px;padding:9px;text-decoration:none}section{margin-bottom:24px;border:1px solid #e1e6f0;border-radius:14px;background:white;padding:20px}section img{display:block;width:100%;height:auto;margin-top:16px;border:1px solid #e1e6f0;border-radius:8px}h2{font-size:19px;margin-top:0}p,li{line-height:1.6}a:focus-visible,.table-scroll:focus-visible{outline:3px solid #8ba0ec;outline-offset:3px}.table-scroll{overflow-x:auto;border:1px solid #e1e6f0;border-radius:10px}table{width:100%;min-width:1000px;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:13px;vertical-align:top;border-bottom:1px solid #e8edf5}thead{background:#f6f8fc}th small{display:block;font-weight:400;color:#68758e;font-size:12px;margin-top:6px}.pass,.attention{display:inline-block;padding:5px 7px;border-radius:6px;font-weight:650;white-space:nowrap}.pass{background:#e8f7ef;color:#21835f}.attention{background:#fff0e4;color:#9c531d}</style>
<header><h1>$heading</h1><p>$description</p><nav>$nav</nav></header><main>$cards</main></html>
"@
$html | Set-Content -LiteralPath (Join-Path $review.directory $pageName) -Encoding utf8
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$python = (Get-Command python -ErrorAction Stop).Source
$server = Start-Process -FilePath $python -ArgumentList @('-m','http.server',"$port",'--bind','127.0.0.1','--directory',('"'+$review.directory+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $review.directory "$logName.stdout.log") -RedirectStandardError (Join-Path $review.directory "$logName.stderr.log")
$url = "http://127.0.0.1:$port/$pageName"
$ready=$false
for($attempt=0;$attempt -lt 30;$attempt++) { try { $response=Invoke-WebRequest $url -TimeoutSec 2; if($response.StatusCode -eq 200){$ready=$true;break} } catch { Start-Sleep -Milliseconds 200 } }
if(-not $ready){ throw 'Screenshot gallery did not become ready' }
@{ pid=$server.Id; url=$url; directory=$review.directory;section=$Section } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $review.directory $manifestName)
Write-Output "Review gallery: $url"
