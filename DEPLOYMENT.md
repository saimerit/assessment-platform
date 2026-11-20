# Production deployment

Deployment and installer publication are **deferred by the user as of 19 November
2026** while roadmap sections are built and reviewed. The instructions below
describe future requirements; local isolated review containers are not a target
rollout. See [section 1C's contract](docs/attempt-submission-contract.md).

`compose.yaml` deliberately runs only stateless application containers. PostgreSQL,
Redis, and RabbitMQ are supplied through their managed TLS endpoints; they are not
published by this stack. The Caddy gateway is the sole published service and routes
`/api/*` to the API, so the portal image has no environment-specific API URL baked
into it.

1. Copy `.env.example` to `.env` outside source control and replace every
   `REPLACE_ME` value with secrets from your secret manager. Rotate the legacy JWT
   and database passwords before deployment.
2. Set `PORTAL_DOMAIN`, `PUBLIC_APP_URL`, and `CLIENT_RELEASE_URL` for the target
   environment. Ensure DNS points at the gateway and ports 80/443 are reachable for
   ACME certificate issuance.
3. Apply database migrations with the schema administrator before starting the
   corresponding API version. This change requires
   `init-scripts/10_attempt_authorization.sql` and
   `init-scripts/11_attempt_checkpoints.sql` and
   `init-scripts/12_submission_delivery.sql` after migrations 03–09. The worker
   runtime additionally requires `init-scripts/13_worker_recovery.sql`
   before either worker starts. Section 1D worker images build from the repository
   root with their Dockerfile selected explicitly so the shared Go module is included.
   The local development stack runs these automatically; this production stack does not.
4. Build and distribute Lockdown Client 1.3.0 or newer before rolling out the
   submission/receipt API and matching grader; retain higher configured minimums.
   Migration 12 must be present before either service starts. Configure the release download URL and publish its
   `client_releases` record only after that installer is available. Existing
   invitation links work with the updated client; older clients require an update.
5. Run `docker compose up -d --build`. Only ports 80 and 443 are published.

Worker health/readiness/metrics run privately on port 8091. Configure
`RABBITMQ_MANAGEMENT_URL` for head-of-queue age and keep the worker retry policy
consistent across instances. Production notification delivery uses explicit
`SMTP_MODE=smtp` with host/port configuration; selected local mock delivery audits
as MOCK_SENT. See [the worker recovery contract](docs/worker-recovery-contract.md).
Source and future Compose instructions do not authorize the currently deferred rollout.

For production, inject the same variables from AWS Secrets Manager, GCP Secret
Manager, Vault, or Kubernetes External Secrets rather than storing a `.env` file on
the host. The services fail during startup when required values are absent.

Build multi-architecture images with Buildx, for example:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t registry.example.com/assessment-api:TAG --push ./assessment-api
```
