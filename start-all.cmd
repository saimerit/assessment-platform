@echo off
setlocal
set "COMPOSE_FILE=%~dp0..\docker-compose.yml"

docker compose -f "%COMPOSE_FILE%" up --detach --build
if errorlevel 1 (
    echo Docker Compose failed. Check Docker Desktop and the reported service error.
    pause
    exit /b 1
)

echo.
echo Admin portal:    http://localhost:3000
echo Container logs:  http://localhost:8090/logs.html
echo Assessment API:  http://localhost:8081
start "" "http://localhost:8090/logs.html"
endlocal
