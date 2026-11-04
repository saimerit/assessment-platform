$ErrorActionPreference = 'Stop'
$composeFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'docker-compose.yml'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found.'
}
if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Docker Compose file not found: $composeFile"
}

docker compose -f $composeFile down
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose could not stop the platform.'
}
Write-Host 'Platform containers stopped. Database and Redis volumes were preserved.' -ForegroundColor Green
