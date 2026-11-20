[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$review = Get-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review/latest.json') -Raw | ConvertFrom-Json
$portalRoot = Join-Path $repoRoot 'admin-portal'
$standaloneRoot = Join-Path $portalRoot '.next/standalone'
if (-not (Test-Path -LiteralPath (Join-Path $standaloneRoot 'server.js'))) { throw 'Build admin-portal with npm run build first.' }

$staticTarget = Join-Path $standaloneRoot '.next/static'
$publicTarget = Join-Path $standaloneRoot 'public'
New-Item -ItemType Directory -Path $staticTarget,$publicTarget -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $portalRoot '.next/static') | Copy-Item -Destination $staticTarget -Recurse -Force
Get-ChildItem -LiteralPath (Join-Path $portalRoot 'public') | Copy-Item -Destination $publicTarget -Recurse -Force
$portalListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portalListener.Start()
$reviewPortalPort = $portalListener.LocalEndpoint.Port
$portalListener.Stop()
$savedReviewPort = $env:PORT
$savedReviewHostname = $env:HOSTNAME
try {
    $env:PORT = "$reviewPortalPort"
    $env:HOSTNAME = '127.0.0.1'
    $previewPortal = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.js' -WorkingDirectory $standaloneRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $review.directory 'portal-preview.stdout.log') -RedirectStandardError (Join-Path $review.directory 'portal-preview.stderr.log') -PassThru
    [pscustomobject]@{pid=$previewPortal.Id;url="http://127.0.0.1:$reviewPortalPort";started_at=$previewPortal.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $review.directory 'portal-preview.json')
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$reviewPortalPort" -TimeoutSec 2 -SkipHttpErrorCheck
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        if ($previewPortal.HasExited) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { Get-Content -LiteralPath (Join-Path $review.directory 'portal-preview.stderr.log'); throw 'Built portal preview did not become ready.' }
    Write-Output "Built portal preview: http://127.0.0.1:$reviewPortalPort (PID $($previewPortal.Id)). Close this review server before rebuilding admin-portal on Windows."
} finally {
    $env:PORT = $savedReviewPort
    $env:HOSTNAME = $savedReviewHostname
}
