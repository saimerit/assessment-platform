[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$review = Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json') -Raw | ConvertFrom-Json
if ($review.network -notmatch '^assessment-auth-review-[a-f0-9]{12}$') { throw 'Use an isolated review environment' }
& (Join-Path $PSScriptRoot 'new-checkpoint-review-fixtures.ps1')
$scriptPath = Join-Path $PSScriptRoot 'check-checkpoint-review-ui.cjs'
$electron = Join-Path $repoRoot 'lockdown-client\node_modules\electron\dist\electron.exe'
foreach($model in @('event','legacy')) {
    foreach($phase in @('offline','resume')) {
        if ($phase -eq 'resume') {
            docker restart "$($review.network)-api" | Out-Null
            if($LASTEXITCODE -ne 0){ throw 'Isolated API restart failed' }
            for($attempt=0;$attempt -lt 30;$attempt++) {
                try { $response=Invoke-WebRequest "$($review.gateway_url)/api/healthz" -TimeoutSec 2; if($response.StatusCode -eq 200){break} } catch { Start-Sleep -Milliseconds 300 }
            }
        }
        $arguments=@(('"'+$scriptPath+'"'),"--$phase")
        if($model -eq 'legacy'){$arguments+='--legacy'}
        $stdout=Join-Path $review.directory "checkpoint-$model-$phase.stdout.log"
        $stderr=Join-Path $review.directory "checkpoint-$model-$phase.stderr.log"
        $process=Start-Process -FilePath $electron -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        Get-Content -LiteralPath $stdout
        if($process.ExitCode -ne 0){Get-Content -LiteralPath $stderr;throw "Checkpoint $model/$phase failed"}
    }
}
Write-Output 'Both execution models passed the built UI restart/reconnect/submission checks.'
