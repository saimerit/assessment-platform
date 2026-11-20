[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$latestPath = Join-Path $repoRoot '.attempt-access-review\latest.json'
if (-not (Test-Path -LiteralPath $latestPath)) { throw 'No saved attempt review environment was found.' }
$review = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
if ($review.suffix -notmatch '^[a-f0-9]{12}$') { throw 'Invalid review environment identifier.' }
$networkName = "assessment-auth-review-$($review.suffix)"
$expectedNames = @("assessment-auth-test-pg-$($review.suffix)", "assessment-auth-test-redis-$($review.suffix)", "$networkName-rabbit", "$networkName-api", "$networkName-portal", "$networkName-gateway")
$existingNames = @(docker ps -a --format '{{.Names}}')
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Docker containers.' }
foreach ($name in $expectedNames) {
    if ($existingNames -contains $name) {
        docker rm -f $name | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not remove review container $name." }
    }
}
$networks = @(docker network ls --format '{{.Name}}')
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Docker networks.' }
if ($networks -contains $networkName) {
    docker network rm $networkName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the review network.' }
}
$review | Add-Member -NotePropertyName stopped_at -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
$review | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $latestPath
Write-Output 'Stopped the isolated review services. Test reports and fixtures remain saved; close the review desktop window separately.'
