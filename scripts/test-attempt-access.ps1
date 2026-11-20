[CmdletBinding()]
param([switch]$KeepForReview)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testSuffix = [guid]::NewGuid().ToString('N').Substring(0, 12)
$postgresName = "assessment-auth-test-pg-$testSuffix"
$redisName = "assessment-auth-test-redis-$testSuffix"
$savedDatabaseURL = $env:TEST_DATABASE_URL
$savedRedisURL = $env:TEST_REDIS_URL
$savedReviewManifest = $env:TEST_REVIEW_MANIFEST
$testsPassed = $false
$reviewDirectory = Join-Path $repoRoot ".attempt-access-review\$testSuffix"

try {
    if ($KeepForReview) {
        New-Item -ItemType Directory -Path $reviewDirectory -Force | Out-Null
        $env:TEST_REVIEW_MANIFEST = Join-Path $reviewDirectory 'fixtures.json'
    } else { $env:TEST_REVIEW_MANIFEST = $null }
    # Disposable containers run the same bootstrap and migration files as local
    # development, with explicit test-only credentials and random loopback ports.
    docker run -d --name $postgresName -e POSTGRES_USER=root -e POSTGRES_PASSWORD=test-only-password -e ASSESSMENT_APP_DB_PASSWORD=test-app-password -e ASSESSMENT_GRADER_DB_PASSWORD=test-grader-password -e CLIENT_RELEASE_URL=https://example.test/client.exe -p '127.0.0.1::5432' --mount "type=bind,source=$repoRoot\schemas,target=/schemas,readonly" --mount "type=bind,source=$repoRoot\init-scripts\01-init-databases.sql,target=/docker-entrypoint-initdb.d/01-init-databases.sql,readonly" --mount "type=bind,source=$repoRoot\init-scripts\02-init-assessment-db.sql,target=/docker-entrypoint-initdb.d/02-init-assessment-db.sql,readonly" --mount "type=bind,source=$repoRoot\init-scripts,target=/migrations,readonly" postgres:16-alpine | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the test PostgreSQL container.' }
    docker run -d --name $redisName -p '127.0.0.1::6379' redis:7-alpine | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the test Redis container.' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        docker exec $postgresName pg_isready -h 127.0.0.1 -U root -d assessment_db *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { docker logs $postgresName; throw 'Test database did not become ready.' }
    $migrations = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'init-scripts') -Filter '*.sql' | Where-Object { $_.Name -notmatch '^0[12]-' } | Sort-Object Name)
    foreach ($migration in $migrations) {
        docker exec $postgresName psql -U root -d assessment_db -v ON_ERROR_STOP=1 -f "/migrations/$($migration.Name)" *> $null
        if ($LASTEXITCODE -ne 0) { throw "Test migration failed: $($migration.Name)" }
    }
    docker exec $postgresName psql -U root -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE assessment_attempt_auth_test TEMPLATE assessment_db;' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone the migrated test database.' }
    # Verify the new migration is repeatable without restoring a revoked unlock.
    docker exec $postgresName psql -U root -d assessment_db -v ON_ERROR_STOP=1 -f /migrations/10_attempt_authorization.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Attempt authorization migration is not repeatable.' }
    docker exec $postgresName psql -U root -d assessment_db -v ON_ERROR_STOP=1 -f /migrations/11_attempt_checkpoints.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Attempt checkpoint migration is not repeatable.' }
    docker exec $postgresName psql -U root -d assessment_db -v ON_ERROR_STOP=1 -f /migrations/12_submission_delivery.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Submission delivery migration is not repeatable.' }
    docker exec $postgresName psql -U root -d assessment_db -v ON_ERROR_STOP=1 -f /migrations/13_worker_recovery.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Worker recovery migration is not repeatable.' }
    $postgresPort = ((docker port $postgresName 5432/tcp) -split ':')[-1].Trim()
    $redisPort = ((docker port $redisName 6379/tcp) -split ':')[-1].Trim()
    $env:TEST_DATABASE_URL = "postgres://root:test-only-password@127.0.0.1:$postgresPort/assessment_attempt_auth_test?sslmode=disable"
    $env:TEST_REDIS_URL = "redis://127.0.0.1:$redisPort/0"
    Push-Location (Join-Path $repoRoot 'assessment-api')
    try {
        go test ./... -count=1
        if ($LASTEXITCODE -ne 0) { throw 'Attempt authorization tests failed.' }
    } finally { Pop-Location }
    Push-Location (Join-Path $repoRoot 'grading-worker')
    try {
        go test ./... -count=1
        if ($LASTEXITCODE -ne 0) { throw 'Frozen grading tests failed.' }
    } finally { Pop-Location }
    Push-Location (Join-Path $repoRoot 'worker-runtime')
    try { go test ./... -count=1; if ($LASTEXITCODE -ne 0) { throw 'Worker recovery tests failed.' } } finally { Pop-Location }
    Push-Location (Join-Path $repoRoot 'notification-worker')
    try { go test ./... -count=1; if ($LASTEXITCODE -ne 0) { throw 'Notification worker tests failed.' } } finally { Pop-Location }
    Push-Location (Join-Path $repoRoot 'lockdown-client')
    try {
        node --test tests/AttemptClient.test.mjs tests/AttemptCheckpointClient.test.mjs tests/AttemptSubmissionClient.test.mjs tests/SubmissionReceiptVerifier.test.mjs tests/SubmissionExitTimer.test.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Desktop credential tests failed.' }
        npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Desktop type checks failed.' }
    } finally { Pop-Location }
    $testsPassed = $true
    if ($KeepForReview) {
        $reviewInfo = [ordered]@{ directory=$reviewDirectory; suffix=$testSuffix; postgres=$postgresName; redis=$redisName; created_at=[DateTime]::UtcNow.ToString('o') }
        $reviewInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repoRoot '.attempt-access-review\latest.json')
        Write-Output "Review fixtures retained in $reviewDirectory"
    }
} finally {
    $env:TEST_DATABASE_URL = $savedDatabaseURL
    $env:TEST_REDIS_URL = $savedRedisURL
    $env:TEST_REVIEW_MANIFEST = $savedReviewManifest
    if (-not ($KeepForReview -and $testsPassed)) { docker rm -f $postgresName $redisName *> $null }
}
