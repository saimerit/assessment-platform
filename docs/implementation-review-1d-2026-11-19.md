# Section 1D — worker recovery checkpoint

Implemented and command-verified on 19 November 2026. All eight live recovery
groups passed. User visual/readout review was accepted on 20 November 2026.
Deployment remains deferred; implementation stops at this accepted checkpoint
before Batch 2.

## Changes and dependencies

Both workers share a consumer/retry/health runtime, persist execution attempts,
route bounded delayed retries and dead letters with confirmed publication, and
reconnect without manual worker restart. Grading keeps one effective frozen result.
Notification SMTP operations are cancellable and committed audit/completion skips
duplicate sends. The worker-only answer vault and candidate result confidentiality
are preserved. Missing SMTP configuration is explicit, and local mock delivery is
recorded as MOCK_SENT.

Migration 13 supplies execution metadata and the previously missing notification
audit table. Worker Dockerfiles/Compose use the repository root for the shared Go
module. Health interfaces stay private. See the
[worker contract](worker-recovery-contract.md) for identities, defaults, atomic
completion, queue topology, operational limits and SMTP's acceptance/commit gap.

## Completed source checks

- Disposable PostgreSQL/Redis API and frozen grading checks passed. Migrations
  10–13 rerun successfully. Existing candidate access/answer/receipt tests remain
  green, and all 29 desktop service tests/type checks pass.
- Five shared-runtime tests pass: eight competing claims obtain one lease;
  retry deadlines and counts persist across new store instances; exhaustion and
  body-identity conflicts quarantine work; transaction rollback cannot publish
  completion; completed claims remain idempotent; lock waits honor deadlines;
  queue age/unknown metadata and readiness/redaction are checked. Invalid envelope
  identities are quarantined, and unconfirmed routing cannot ACK the original.
- Two notification tests pass: a stalled SMTP greeting cancels/closes within the
  processing context, and production SMTP configuration/explicit mock mode and
  mail header validation behave as specified.
- Both worker packages, native Linux binaries and final application images build.
  Production/local Compose configurations validate. The final disposable suite
  includes the shared runtime and notification tests alongside existing API,
  grading and 29 desktop tests/type checks.
- The generated four-group readout renders all eight command checks and health
  observations, supports keyboard focus and contains tables at narrow/200% zoom.

## Completed live checks — eight groups

All use only the isolated review network/database and local SMTP sink. The test
profile uses three attempts, a one-second processing deadline and 2/3/4-second
retry queues to make failure tests practical. Production defaults remain five
attempts and 15 seconds.

| Check | Command scenario | Expected result | Estimate |
| --- | --- | --- | --- |
| 1D-T1 | Duplicate notification job | One local SMTP acceptance and committed audit; repeated delivery skips processing | <1 min |
| 1D-T2 | Malformed/unsupported grading jobs | Permanent failures reach durable dead letters after one attempt | <1 min |
| 1D-T3 | SMTP failure and worker restart during retry | Stored delays apply; restart retains count; job stops at three test attempts | 1–2 min |
| 1D-T4 | Stalled SMTP connection with old enqueue time | Context closes socket; timeout retries/exhausts; queue-age alert is visible | 1–2 min |
| 1D-T5 | Temporarily locked grading keys | SQL cancels at deadline, delayed retry produces one legacy result after lock release | <1 min |
| 1D-T6 | Broker disconnect with pending retry and a new submission | Readiness becomes 503; both consumers reconnect without process restart; retry and grade recover | 1–2 min |
| 1D-T7 | Eight repeated grading deliveries | One effective result and unchanged evaluation timestamp/receipt | <1 min |
| 1D-T8 | Identity mismatch and health/metrics review | Mismatch quarantined; queue-age/dead-letter alerts and metrics contain no job bodies, credentials or scores | <1 min |

All eight groups passed against the final worker binaries. Both consumers became
not ready during broker loss, then rebuilt their connections without process
restart. The pending notification retry and a new durable grading submission
completed after recovery. Eight extra grading deliveries retained one effective
result and its original evaluation time. Candidate receipts remained submission
only. All SMTP traffic stayed in the local sink.

Evidence: [live results](../.attempt-access-review/6993480425c7/worker-recovery-results.json)
and [readout checks](../.attempt-access-review/6993480425c7/worker-readout-results.json).
Retained dead letters from repeated negative tests explain nonzero initial/final
counts; they are not production failures. Counts are job/queue observations, not
candidate scores. Queue age is explicitly Unknown when metadata is missing or
lags current queue counts; oldest outstanding-job age remains separately visible.

## Four user review groups — accepted on 20 November 2026

Open the [worker recovery readout](http://127.0.0.1:58258/worker-review.html).
Select each numbered navigation link. Command behavior is already verified;
review the clarity of the operator evidence below. This readout is not a new
production operator dashboard and shows no message bodies or candidate results.

| Check | What to review | Expected | Estimate |
| --- | --- | --- | --- |
| 1D-V1 | Healthy workers and policy note | Worker names, Ready labels and queue counts are clear; test policy is distinguished from production defaults | 1–2 min |
| 1D-V2 | Retry/timeout observations | Retry count and age fields are readable; Unknown is understandable; leased/outstanding work explains the age alert | 1–2 min |
| 1D-V3 | Disconnect/recovery comparison | Not ready changes to Ready; connection count increases; no candidate grading status appears | 1–2 min |
| 1D-V4 | Dead-letter attention and eight checks | Alert remains visible while the consumer is ready; table scrolling/focus at 200% keeps fields reachable | 2 min |

The user replied “Yes” to the question covering all four groups. 1D-V1–V4 and
1D-R1 are accepted in the checklist. The original review estimate was 5–8 minutes.
This records visual/readout acceptance alongside existing command evidence; it
does not claim another manual outage walkthrough or deployment approval.

## Exact local setup

From `C:\projects\DOA\assessment-platform`, with Docker's engine responsive:

```powershell
.\scripts\test-attempt-access.ps1
.\scripts\start-worker-review.ps1
.\scripts\new-checkpoint-review-fixtures.ps1
node .\scripts\check-worker-recovery.cjs
.\scripts\open-checkpoint-review-gallery.ps1 -Section 1D
```

The setup uses the existing ignored `.attempt-access-review/latest.json`, applies
migration 13 to its test database and builds/replaces only review application
containers. It adds a local SMTP sink and notification worker; their loopback
health/control URLs are stored in `worker-review.json`. No message is relayed to
an external mail server. The live checker stops/restores only the review broker,
restarts only its notification worker and uses a bounded test-only grading lock.
It restores the broker/sink mode on error. It does not restart the Docker engine
or modify the original platform.

If current images are already built, `start-worker-review.ps1 -SkipBuild` recreates
only the review application containers using those images. The setup resumes
stopped review dependencies, refreshes the gateway's actual port and uses explicit
loopback health bindings so worker restarts retain their URLs. Gallery URL/PID is
stored in `worker-gallery.json` and can change when reopened.

Passing live checks write `worker-recovery-results.json` in the current review
directory. A missing/failed artifact is not a passed section. Repeating requires
fresh fixtures. Retained dead letters are test evidence, not candidate results or
production queue administration.

## Next action

Await continuation at the accepted 1D boundary. Section 2A is next in the roadmap;
combined Batch 1 review gate G1-05 remains open. Migration/installer rollout is
explicitly deferred. Two earlier 1A observations and the existing Next.js
dependency advisory remain separately open.
