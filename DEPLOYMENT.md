# Production deployment

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
3. Run `docker compose up -d --build`. Only ports 80 and 443 are published.

For production, inject the same variables from AWS Secrets Manager, GCP Secret
Manager, Vault, or Kubernetes External Secrets rather than storing a `.env` file on
the host. The services fail during startup when required values are absent.

Build multi-architecture images with Buildx, for example:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t registry.example.com/assessment-api:TAG --push ./assessment-api
```
