[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
$review=Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json') -Raw | ConvertFrom-Json
if($review.network -notmatch '^assessment-auth-review-[a-f0-9]{12}$'){throw 'Use the isolated review environment'}
& (Join-Path $PSScriptRoot 'new-checkpoint-review-fixtures.ps1')
$fixtures=Get-Content -LiteralPath (Join-Path $review.directory 'checkpoint-fixtures.json') -Raw | ConvertFrom-Json
docker exec $review.postgres psql -U root -d assessment_attempt_auth_test -v ON_ERROR_STOP=1 -c "UPDATE assessment_blueprints SET duration_minutes=1 WHERE id='$($fixtures.blueprint_id)'" | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not set the one-minute synthetic deadline'}
$scriptPath=Join-Path $PSScriptRoot 'check-checkpoint-review-ui.cjs'
$electron=Join-Path $repoRoot 'lockdown-client\node_modules\electron\dist\electron.exe'
foreach($model in @('event','legacy')){
 $arguments=@(('"'+$scriptPath+'"'))
 if($model -eq 'event'){$arguments+='--receipt-review'}else{$arguments+=@('--legacy','--deadline-review')}
 $stdout=Join-Path $review.directory "submission-$model.stdout.log"
 $stderr=Join-Path $review.directory "submission-$model.stderr.log"
 $process=Start-Process -FilePath $electron -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
 Get-Content -LiteralPath $stdout
 if($process.ExitCode -ne 0){Get-Content -LiteralPath $stderr;throw "Submission UI $model checks failed"}
}
foreach($model in @('event','legacy')){
 $arguments=@(('"'+$scriptPath+'"'),'--auto-close-review')
 if($model -eq 'legacy'){$arguments+='--legacy'}
 $stdout=Join-Path $review.directory "submission-$model-auto-close.stdout.log"
 $stderr=Join-Path $review.directory "submission-$model-auto-close.stderr.log"
 $process=Start-Process -FilePath $electron -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
 if(-not $process.WaitForExit(75000)){Stop-Process -Id $process.Id;throw 'Automatic receipt close exceeded 75 seconds'}
 Get-Content -LiteralPath $stdout
 if($process.ExitCode -ne 0){Get-Content -LiteralPath $stderr;throw "Automatic receipt close $model failed"}
 $result=Get-Content -LiteralPath (Join-Path $review.directory "submission-$model-auto-close-results.json") -Raw | ConvertFrom-Json
 $uiResult=Get-Content -LiteralPath (Join-Path $review.directory "submission-$model-ui-results.json") -Raw | ConvertFrom-Json
 if($result.passed -ne 1 -or $result.receipt -ne $uiResult.receipt -or $result.elapsed_ms -lt 59500 -or $result.elapsed_ms -gt 65000){throw 'Automatic close did not meet the one-minute deadline for this receipt'}
}
Write-Output 'Submission receipt and real deadline UI checks passed.'
