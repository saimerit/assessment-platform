# Local Docker development stack

From this repository root, run:

```powershell
.\start-all.ps1
```

The launcher creates an ignored `.env.local` containing unique throwaway
credentials, then starts PostgreSQL, Redis, RabbitMQ, migrations, the API,
workers, portal, and a local Caddy gateway. Open <http://localhost:3000> for
both the portal and API (`/api`). No frontend rebuild is needed if the API host
changes because browser traffic remains same-origin.

Stop the stack while retaining local data:

```powershell
.\stop-all.ps1
```

For a fresh local database, run `docker compose --env-file .env.local -f
compose.local.yaml down -v`, then start it again. RabbitMQ management is
available at <http://localhost:15672> using `guest` / `guest`.

If another local stack owns the default ports, set `LOCAL_PORT`,
`LOCAL_POSTGRES_PORT`, `LOCAL_REDIS_PORT`, `LOCAL_RABBITMQ_PORT`, and
`LOCAL_RABBITMQ_MANAGEMENT_PORT` in the invoking shell before running the
launcher.

The Electron Lockdown Client is a native Windows desktop application, not a
server process. It needs the host desktop session, camera/microphone access,
monitor enumeration, and Windows kiosk controls, so Docker runs its supporting
API but does not launch the client UI. Continue distributing/running the
Windows Electron build on the candidate's machine.

The question-paper generator is an on-demand Compose tool:

```powershell
docker compose -f ..\docker-compose.yml --profile tools run --rm qp-generator
```
