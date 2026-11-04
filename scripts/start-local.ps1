[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.local'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install and start Docker Desktop, then retry.'
}

if (-not (Test-Path -LiteralPath $envFile)) {
    function New-LocalSecret([int]$bytes = 32) {
        $buffer = [byte[]]::new($bytes)
        [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
        return [Convert]::ToHexString($buffer).ToLowerInvariant()
    }

    $content = @"
# Generated for local development only. Do not commit this file.
POSTGRES_PASSWORD=$(New-LocalSecret 24)
ASSESSMENT_APP_DB_PASSWORD=$(New-LocalSecret 24)
ASSESSMENT_GRADER_DB_PASSWORD=$(New-LocalSecret 24)
JWT_SECRET=$(New-LocalSecret 48)
PUBLIC_APP_URL=http://localhost:3000
CLIENT_RELEASE_URL=http://localhost:3000/downloads/AssessmentLockdownClient.exe
ASSESSMENT_API_URL=http://localhost:3000/api
PUBLIC_PORTAL_URL=http://localhost:3000
SMTP_HOST=
SMTP_PORT=
SMTP_SENDER=
"@
    Set-Content -LiteralPath $envFile -Value $content -NoNewline
    Write-Host 'Created .env.local with unique local-only credentials.' -ForegroundColor DarkGray
}

Push-Location $root
try {
    docker compose --env-file .env.local -f compose.local.yaml up --detach --build
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not start the local platform.' }
    docker compose --env-file .env.local -f compose.local.yaml ps
} finally {
    Pop-Location
}

Write-Host ''
$localPort = if ($env:LOCAL_PORT) { $env:LOCAL_PORT } else { '3000' }
$rabbitPort = if ($env:LOCAL_RABBITMQ_MANAGEMENT_PORT) { $env:LOCAL_RABBITMQ_MANAGEMENT_PORT } else { '15672' }
Write-Host "Portal and API: http://localhost:$localPort" -ForegroundColor Green
Write-Host "RabbitMQ:       http://localhost:$rabbitPort (guest/guest)" -ForegroundColor Green
Write-Host "Electron: set ASSESSMENT_API_URL=http://localhost:$localPort/api and PUBLIC_PORTAL_URL=http://localhost:$localPort before launching." -ForegroundColor Green
