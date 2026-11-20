[CmdletBinding()]
param([string]$InvitationToken = 'test-event-invitation', [switch]$EntryScreen)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$review = Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json') -Raw | ConvertFrom-Json
if (-not $review.gateway_url) { throw 'Run scripts/start-attempt-review.ps1 first.' }
if ($InvitationToken -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'Use a valid review invitation token.' }
$savedApiURL = $env:ASSESSMENT_API_URL
$savedPortalURL = $env:PUBLIC_PORTAL_URL
try {
    $env:ASSESSMENT_API_URL = "$($review.gateway_url)/api"
    $env:PUBLIC_PORTAL_URL = $review.gateway_url
    $clientRoot = Join-Path $repoRoot 'lockdown-client'
    $arguments = @(('"'+$clientRoot+'"'))
    if (-not $EntryScreen) { $arguments += 'lockdown://open?token=' + [Uri]::EscapeDataString($InvitationToken) }
    $client = Start-Process -FilePath (Join-Path $clientRoot 'node_modules\electron\dist\electron.exe') -ArgumentList $arguments -WorkingDirectory $clientRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $review.directory 'client.stdout.log') -RedirectStandardError (Join-Path $review.directory 'client.stderr.log') -PassThru
    $review | Add-Member -NotePropertyName client_pid -NotePropertyValue $client.Id -Force
    $review | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json')
    if ($EntryScreen) { Write-Output "Started review client (PID $($client.Id)) at invitation entry." }
    else { Write-Output "Started review client (PID $($client.Id)) with invitation $InvitationToken." }
} finally {
    $env:ASSESSMENT_API_URL = $savedApiURL
    $env:PUBLIC_PORTAL_URL = $savedPortalURL
}
