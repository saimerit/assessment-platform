$ErrorActionPreference = 'Stop'
$composeFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'docker-compose.yml'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install/start Docker Desktop, then run this script again.'
}
if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Docker Compose file not found: $composeFile"
}

Write-Host 'Starting Assessment Platform containers...' -ForegroundColor Cyan
docker compose -f $composeFile up --detach --build
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose could not start the platform. Open the log dashboard after fixing the reported container error.'
}

docker compose -f $composeFile ps
Write-Host ''
Write-Host 'Admin portal:   http://localhost:3000' -ForegroundColor Green
Write-Host 'Container logs: http://localhost:8090/logs.html' -ForegroundColor Green
Write-Host 'API:            http://localhost:8081' -ForegroundColor Green
Write-Host 'The lockdown client is a native Windows desktop app and must be launched on the host.' -ForegroundColor DarkGray
