$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    docker compose --env-file .env.local -f compose.local.yaml down
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not stop the local platform.' }
} finally {
    Pop-Location
}

Write-Host 'Local platform stopped. Volumes are retained.' -ForegroundColor Green
