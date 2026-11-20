# Worker recovery — section 1D

19 November 2026. Requires migration 13 and the matching grading/notification
worker binaries. Deployment is deferred. This extends the
[submission contract](attempt-submission-contract.md).

## Shared execution infrastructure

`worker-runtime` is the local Go module `assessment/workerqueue`. Both workers use
the same consumer lifecycle, durable execution ledger, publisher confirmation,
retry topology and health reporting. Domain handlers retain frozen scoring and
notification rendering/delivery. The grading worker keeps its separate database
role and worker-only vault access. Health responses never contain job bodies,
candidate email addresses, passwords, answers or scores.

Migration 13 adds `worker_jobs` and the notification audit table that the previous
worker referenced but the bootstrap did not create. The execution ledger stores
queue/job identity, body hash, attempt count, state, timestamps, lease and safe
error code. It stores no message contents. Application and grading roles can
maintain execution metadata; only the application role can write notification
audit records. Existing organization-scoped API access and result confidentiality
remain unchanged.

## Identity, retries and delivery

The broker `MessageId` is the stable job identity within its source queue. Older
messages without an ID use a hash of their exact body. Reusing an identity with a
different body is quarantined without replacing the original job. Identical
legacy bodies therefore deduplicate; explicit new notification requests use new
IDs. Submission/version remains the grading domain's effective-result identity.

The ledger states are PENDING, RUNNING, RETRYING, SUCCEEDED,
DEAD_LETTER_PENDING and DEAD_LETTER. A PostgreSQL row lock serializes claims and
increments the attempt budget once per actual execution. A live lease or future
retry timestamp delays a duplicate instead of executing it again. Server wall
time is read after the row lock. Process/broker restart cannot reset the count.

Default policy includes the first execution in a **five-attempt** budget, with a
**15-second processing deadline**. Failed executions wait 2, 10, 30 and 60 seconds
before their next attempt. Invalid JSON, unsupported grading versions and invalid
notification fields are permanent failures. Transient failures, processor panics
and deadlines consume the bounded budget. Exhaustion and permanent failures
become dead letters. A worker dependency failure before a successful claim leaves
the original message unacknowledged rather than discarding it.

The existing source queues remain unchanged. Durable quorum retry queues are
named `<source>.retry.<milliseconds>` and expire back to the source queue through
at-least-once dead lettering with reject-publish overflow. Quorum dead-letter
queues are `<source>.dead`. This needs a RabbitMQ version/configuration supporting
quorum queues and at-least-once dead lettering (the review uses RabbitMQ 3).
Changing retry timings creates distinct queues; drain old retry queues before
removing them during a future operator-managed rollout.

Retry/dead-letter routing uses persistent messages, mandatory routing and
publisher confirms. The original delivery is ACKed only after confirmed routing
or committed successful handling. An uncertain publication/database acknowledgment
can yield another delivery or duplicate dead-letter entry; the ledger identity
and grading version prevent another effective grade. Dead-letter state is marked
after confirmed publication. A resumed pending dead-letter route republishes the
original body and safe error code.

## Processing, commits and reconnect

Handlers receive a cancellable processing context. Grading SQL/transactions and
SMTP DNS/connect/greeting/TLS/envelope/DATA operations respect it. SMTP socket
closure is also tied to context cancellation. SMTP DATA's final acceptance reply
is the transport acceptance point; the worker closes without waiting on QUIT.

Grading result, GRADED submission status and queue execution completion commit in
the same transaction. Repeated/concurrent submission-version jobs retain the
original effective result and evaluation timestamp. Successful notification audit
and execution completion also commit together before ACK. Audit/database failures
are processing failures rather than ignored writes.

SMTP acceptance occurs outside PostgreSQL. A process/database failure after SMTP
acceptance but before the audit/completion commit can resend mail. This is not
exactly-once email delivery. Committed successful jobs skip subsequent SMTP calls.
Provider-specific idempotency and producer notification outboxes remain 2D.

Both workers rebuild their broker connections, channels, QoS and consumers after
disconnects or failed routing. Reconnect waits grow from one second to at most ten
seconds; there is no immediate NACK/requeue loop. Consumer-prefetch is one.
Shutdown signals cancel active work and leave unacknowledged deliveries for
recovery. Failed in-flight work retains its lease/budget; a later claim can resume
after the lease expires. Durable dead letters remain quarantined after dependencies
recover. Audited inspection/replay and ledger reset controls remain 2G.

## Runtime configuration

| Setting | Default / meaning |
| --- | --- |
| `WORKER_MAX_ATTEMPTS` | 5; valid range 1–10, including initial execution |
| `WORKER_PROCESSING_TIMEOUT` | 15s; per processing attempt |
| `WORKER_RETRY_DELAYS` | `2s,10s,30s,60s`; ascending delays, last reused for larger budgets |
| `WORKER_MONITOR_INTERVAL` | 5s |
| `WORKER_QUEUE_AGE_WARNING` | 5m |
| `WORKER_HEALTH_ADDRESS` | `:8091`; private service interface |
| `RABBITMQ_MANAGEMENT_URL` | Optional trusted base URL; needed for exact head-of-queue age |
| `SMTP_MODE` | `smtp` by default; explicit `mock` only for selected local/test delivery |

Management requests use the broker credentials and require permission to inspect
the selected vhost queues. Configure a TLS management URL for a remote production
broker. Duration settings are bounded and invalid policies fail startup. SMTP mode
requires host/port configuration; missing production SMTP does not silently report
mock mail as sent. Mock audits say MOCK_SENT. Local Compose explicitly defaults to
mock; production Compose defaults to smtp.

## Health, queue age and alerts

Each worker exposes private `/healthz`, `/readyz` and `/metrics` on port 8091.
Liveness stays reachable during disconnects. Readiness is 503 while broker or
execution-database access is unavailable, and 200 when consumption is usable.
Outstanding dead letters can coexist with a ready consumer.

JSON and Prometheus expose readiness, connection count, ready/retry/dead-letter
counts, failed/completed jobs and oldest observed pending-job age. JSON also
identifies current leases. Management
metadata supplies head timestamps across source/retry queues without consuming or
requeueing messages. New API messages carry enqueue timestamps; retries preserve
them. Missing timestamps, unavailable metadata or metadata lagging current queue
counts produce an explicit unknown queue age, never a fabricated zero. Empty queues
have a known zero age based on current queue inspection. Legacy retries retain
unknown timestamp status. Snapshot timestamps identify stale
last-known counts during disconnection. Connection counters reset on process restart;
ledger attempts and outcomes persist.

Alert codes include BROKER_DISCONNECTED, DATABASE_UNAVAILABLE,
QUEUE_AGE_UNAVAILABLE, QUEUE_AGE_HIGH and DEAD_LETTERS_PRESENT. Structured log events
report alert transitions/recovery, execution attempts and safe error codes with
job IDs. Alert delivery to external operator channels, platform health dashboards
and audited dead-letter replay remain 2G. The service endpoints are not published
through the candidate portal or gateway.

Workers now build from the repository root with `-f grading-worker/Dockerfile` or
`-f notification-worker/Dockerfile` so the shared module is available. Root Docker
ignore rules exclude credentials, review artifacts, dependencies and binaries.
Compiler parallelism is bounded in application Dockerfiles; runtime concurrency
is unaffected. See the [1D checkpoint](implementation-review-1d-2026-11-19.md) for
completed checks, user acceptance on 20 November 2026 and exact setup.
