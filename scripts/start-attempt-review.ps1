[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'test-attempt-access.ps1') -KeepForReview
$latestPath = Join-Path $repoRoot '.attempt-access-review\latest.json'
$review = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
$networkName = "assessment-auth-review-$($review.suffix)"
$rabbitName = "$networkName-rabbit"
$apiName = "$networkName-api"
$portalName = "$networkName-portal"
$gatewayName = "$networkName-gateway"
$imageName = "assessment-auth-review-api:$($review.suffix)"
$portalImageName = "assessment-auth-review-portal:$($review.suffix)"
$createdContainers = @($review.postgres, $review.redis)
$started = $false

function Invoke-ReviewDocker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Review Docker command failed: $($Arguments[0])" }
}

try {
    Invoke-ReviewDocker -Arguments @('network','create',$networkName) | Out-Null
    Invoke-ReviewDocker -Arguments @('network','connect',$networkName,$review.postgres)
    Invoke-ReviewDocker -Arguments @('network','connect',$networkName,$review.redis)
    Invoke-ReviewDocker -Arguments @('build','-t',$imageName,(Join-Path $repoRoot 'assessment-api'))
    Invoke-ReviewDocker -Arguments @('run','-d','--name',$rabbitName,'--network',$networkName,'rabbitmq:3-management-alpine') | Out-Null
    $createdContainers += $rabbitName
    $ready = $false
    for ($attempt=0; $attempt -lt 120; $attempt++) {
        # Run diagnostics as the broker user: an early root diagnostic can create
        # .erlang.cookie after the entrypoint's ownership fix and break startup.
        docker exec --user rabbitmq $rabbitName rabbitmq-diagnostics -q check_running *> $null
        if ($LASTEXITCODE -eq 0) { $ready=$true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { docker logs $rabbitName --tail 80; throw 'Review RabbitMQ did not become ready.' }
    # Build the current gateway UI so review does not reuse an outdated portal.
    Invoke-ReviewDocker -Arguments @('build','-t',$portalImageName,(Join-Path $repoRoot 'admin-portal'))
    Invoke-ReviewDocker -Arguments @('run','-d','--name',$portalName,'--network',$networkName,'--network-alias','portal',$portalImageName) | Out-Null
    $createdContainers += $portalName
    Invoke-ReviewDocker -Arguments @('run','-d','--name',$gatewayName,'--network',$networkName,'-p','127.0.0.1::80','--mount',"type=bind,source=$repoRoot\ops\caddy\Caddyfile.local,target=/etc/caddy/Caddyfile,readonly",'caddy:2.10-alpine') | Out-Null
    $createdContainers += $gatewayName
    $gatewayPort = ((docker port $gatewayName 80/tcp) -split ':')[-1].Trim()
    $gatewayURL = "http://127.0.0.1:$gatewayPort"
    $apiArguments = @('run','-d','--name',$apiName,'--network',$networkName,'--network-alias','api',
        '-e','ASSESSMENT_API_PORT=8080',
        '-e',"ASSESSMENT_DATABASE_URL=postgres://assessment_app:test-app-password@$($review.postgres):5432/assessment_attempt_auth_test?sslmode=disable",
        '-e',"REDIS_URL=redis://$($review.redis):6379/0",
        '-e',"RABBITMQ_URL=amqp://guest:guest@$rabbitName`:5672/",
        '-e','JWT_SECRET=review-only-secret-with-at-least-32-characters',
        '-e',"PUBLIC_APP_URL=$gatewayURL",'-e',"CLIENT_RELEASE_URL=$gatewayURL/downloads/review-client.exe",$imageName)
    Invoke-ReviewDocker -Arguments $apiArguments | Out-Null
    $createdContainers += $apiName
    $ready = $false
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        docker exec $apiName wget -q -O - http://127.0.0.1:8080/healthz *> $null
        if ($LASTEXITCODE -eq 0) { $ready=$true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { docker logs $apiName; throw 'Review API did not become ready.' }
    $review | Add-Member -NotePropertyName gateway_url -NotePropertyValue $gatewayURL -Force
    $review | Add-Member -NotePropertyName network -NotePropertyValue $networkName -Force
    $review | Add-Member -NotePropertyName containers -NotePropertyValue $createdContainers -Force
    $review | Add-Member -NotePropertyName api_image -NotePropertyValue $imageName -Force
    $review | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $latestPath
    $started = $true
    Write-Output "Review portal/API: $gatewayURL"
    Write-Output "Event gateway: $gatewayURL/exg/test-event-invitation"
    Write-Output 'Test accounts: assigned@attempt-access.test, other@attempt-access.test, foreign@attempt-access.test, proctor@attempt-access.test'
    Write-Output 'Test password: TestPassword123! | event code: 123456 | legacy code: 654321'
} finally {
    if (-not $started) {
        docker rm -f @createdContainers *> $null
        docker network rm $networkName *> $null
    }
}
