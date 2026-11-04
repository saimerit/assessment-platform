@echo off
setlocal
set "COMPOSE_FILE=%~dp0..\docker-compose.yml"

docker compose -f "%COMPOSE_FILE%" down
if errorlevel 1 (
    echo Docker Compose could not stop the platform.
    pause
    exit /b 1
)

echo Platform containers stopped. Persistent data volumes were kept.
endlocal
