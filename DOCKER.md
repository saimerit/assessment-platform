# Docker development stack

The API, Admin/Exam Gateway, grading worker, notification worker, PostgreSQL,
Redis, RabbitMQ, schema migration, and log dashboard run as Compose services.

From the `assessment-platform` directory:

```powershell
docker compose -f ..\docker-compose.yml up --detach --build
```

Open the Admin/Exam Gateway at <http://localhost:3000> and the live log viewer
at <http://localhost:8090/logs.html>. The log viewer streams stdout and stderr
from containers labeled for the platform over a WebSocket. It is bound to
loopback and uses the Docker Engine socket, so keep it local to a trusted
development machine.

Stop containers without deleting data:

```powershell
docker compose -f ..\docker-compose.yml down
```

`start-all.ps1` and `stop-all.ps1` are now thin wrappers around these Compose
commands; they do not open per-service PowerShell windows. On Windows,
`start-all.cmd` starts the stack and opens the log dashboard in the browser;
`stop-all.cmd` stops the stack. PostgreSQL and Redis volumes are retained by
`down`.

The Assessment API is published on host port 8081 by default. Override it with
`API_PORT=8080` in a Compose `.env` file if that port is free. If changing the
host port, also set `PUBLIC_API_URL` to `http://localhost:<port>/api` before
building the Admin Portal image. SMTP settings are optional; without them the
notification worker records mock delivery in its logs.

The Electron Lockdown Client is a native Windows desktop application, not a
server process. It needs the host desktop session, camera/microphone access,
monitor enumeration, and Windows kiosk controls, so Docker runs its supporting
API but does not launch the client UI. Continue distributing/running the
Windows Electron build on the candidate's machine.

The question-paper generator is an on-demand Compose tool:

```powershell
docker compose -f ..\docker-compose.yml --profile tools run --rm qp-generator
```
