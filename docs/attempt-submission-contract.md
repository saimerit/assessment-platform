# Attempt submission and delivery — section 1C

Implemented 19 November 2026. Requires migrations 10–12 and desktop 1.3.0 or
newer; retain any higher configured minimum. Deployment is deferred by the user.
This extends the [checkpoint contract](attempt-checkpoint-contract.md).

## Shared responsibilities

Both event and legacy adapters use the same lifecycle, pinned-paper, checkpoint,
finalization and receipt services. The API dispatcher owns delivery, the grading
worker owns scoring, the desktop submission controller owns confirmation/retry,
and native main verifies the receipt before releasing kiosk controls. Answer
keys remain in the worker-only answer vault.

## Paper and scoring snapshot

First start pins the public question content, marks, question order, option
content/order, section labels and `objective-v1` scoring policy. A privileged SQL
function copies the matching keys into `answer_vault.attempt_snapshot_keys` after
checking organization and candidate ownership. The API receives the snapshot ID
and public content; it has no SELECT permission on keys. SHARE locks keep source
content and keys consistent during pinning. The timer starts after pinning, with
another entry-window check. Resume retains the existing paper and deadline.

Checkpoint validation and grading use the snapshot, so subsequent authoring
changes cannot change the candidate's paper or grade. The current policy awards
MCQ subset partial credit only when all selected options are correct; wrong,
duplicate or empty choices score zero. FIB answers use Unicode whitespace
trimming and the pinned case-sensitivity rule; blank answers score zero.

Attempts started before this migration can only be recovered from available
current definitions. Their snapshot provenance is `RECOVERED_CURRENT`, rather
than `PINNED_START`. Original historical content and unrecorded submission times
cannot be reconstructed. An existing saved result is preserved without another
grading job; otherwise recovery creates a versioned job from the available
snapshot. Missing/invalid content or keys fail recovery rather than inventing a
grade. Old unversioned queue messages resolve a durable submission before grading;
they never fall back to mutable source definitions.

## Submission and receipt API

| Operation | Event attempt | Legacy attempt |
| --- | --- | --- |
| Finalize | POST `/api/exam/sessions/:session_id/submit` | POST `/api/assessments/:blueprint_id/submit` |
| Retrieve receipt | GET `/api/exam/sessions/:session_id/receipt` | GET `/api/assessments/:blueprint_id/receipt` |

The candidate-bound attempt JWT is required. Current candidate eligibility,
organization, assignment and ownership are rechecked. A completed invitation can
exchange an authenticated candidate account for a receipt credential. Receipt
access remains available after submission/expiry; execution and answer changes
remain blocked. Public invitations and account JWTs cannot retrieve receipts alone.

The desktop sends `{ "checkpoint_revision": 4 }` after saving pending work. A
live stale revision returns 409 and requires synchronization. Submission freezes
the accepted responses and persists one identity with `version: 1`. Repeated or
concurrent submits return the same receipt. The first response is 202; subsequent
retrieval/repeated submission is 200. A receipt not yet available returns 404 with
`code: "NO_RECEIPT"`; a receipt read also attempts eligible deadline/recovery
finalization. A dependency failure returns 503, not a false confirmation.

The receipt contains:

| Field | Meaning |
| --- | --- |
| `submission_id`, `version` | Stable submission/version identity |
| `session_id` or `instance_id` | Authorized execution identity |
| `checkpoint_revision` | Frozen server-accepted response revision |
| `answered_count`, `question_count` | Nonempty accepted responses and paper size |
| `submitted_at` | Manual acceptance time; deadline time for automatic finalization; recovery time for historical recovery |
| `finalized_at`, `timer_expires_at` | Actual receipt creation time and original stored deadline |
| `reason` | `MANUAL`, `DEADLINE` or `RECOVERED` |

All times are UTC in the API. The desktop formats them locally and labels
historical records “Receipt recovered at.” Candidate receipts contain no grading
or delivery status and do not change after private grading. Those processing
fields remain internal to the submission/outbox records.

Candidate assessment listings also omit scores, maximum score and evaluation
time, and map internal EVALUATED state to SUBMITTED. Grading never publishes a
result. Results remain withheld until the evaluator-controlled publication
workflow in 3F is built. The organizer may subsequently select portal release,
optional email delivery or keep recruitment results confidential. No result email
is sent and no publication is inferred from successful grading.

## Deadline and transport policy

There is **zero transport grace for new answer changes**. Eligibility uses the
stored deadline and PostgreSQL `clock_timestamp()`, not arbitrary client times or
transaction-start `NOW()`. An edit must be accepted strictly before the deadline;
exact/after-deadline edits are rejected. Time is checked after parent-attempt
locking and again after writing the batch. A request waiting for a lock does not
keep its earlier arrival time as permission to save late.

Finalization/retrieval may complete later using the last server-accepted snapshot.
After expiry, revision-only finalization uses that snapshot even if the client
revision is stale; compatibility payloads containing new answers are rejected.
The desktop freezes edits when its server-derived clock expires and retains
unknown confirmation recovery until a receipt is retrieved. Unsent offline edits
do not become accepted answers through deadline finalization.

The API scans expired started attempts about once a second and also recovers
earlier completed records without receipts. If the API/database is unavailable,
finalization waits for recovery; it grants no extra answer time. Parent locking
serializes saves, manual submission and the sweep for both execution models.

## Atomic outbox and grading

One PostgreSQL transaction commits the frozen answers, submitted state, receipt
and outbox record. A failed outbox insert rolls back finalization. Broker
availability is not required for API startup or a durable submission receipt.

`submission_outbox` carries a persistent grading payload containing the stable
submission/version, candidate and execution identity. Dispatchers claim due rows
with `FOR UPDATE SKIP LOCKED`, publish persistent messages to the durable
`assessment_submissions` queue using mandatory routing/publisher confirms, then
mark confirmed delivery. Failed delivery stays durable and retries after
1, 2, 4, 8, 16 and at most 32 seconds. Failed connections/channels are discarded
and rebuilt on retry. Publication attempts have a five-second context timeout.

Delivery is at least once: a confirmed message followed by a failed database
acknowledgment can publish again. The grader locks the submission row, checks its
version/identity, scores the frozen answers/keys and commits the result and GRADED
status together. A repeated/concurrent job sees GRADED and leaves the effective
result and evaluation timestamp unchanged.

Worker consumer reconnect, processing deadlines, bounded retries, quorum dead
letters and private health/alerts are now implemented and command-verified in
[1D](worker-recovery-contract.md), awaiting its review. The original 1C outage
harness explicitly restarts its review grader; the 1D checker separately verifies
both consumers recover without a worker process restart.
Existing invitation/notification producers share the publisher, but transactional
notification outboxes remain 2D.

## Desktop confirmation and compatibility

Manual submit saves first, freezes once and retrieves an existing receipt before
trying another finalization. A lost/invalid response shows pending confirmation
and Retry confirmation; it does not clear the encrypted journal or claim success.
A verified receipt clears recovery, displays counts/time, permits full ID
selection and allows reopen without restarting the exam. It shows no grading
status or refresh action, and promises no automatic result delivery.

Native kiosk release requires a server-verified receipt tied to the unchanged
credential generation and execution identity. The same proof schedules application
close after **60 seconds**, independently of grading or renderer activity. Duplicate
completion for the same receipt cannot extend the deadline. Changing the verified
attempt cancels the earlier timer so it cannot terminate a new assessment. The
desktop shows a countdown and immediate Exit application action. If native proof
or close scheduling fails, the received receipt remains valid and the UI directs
the candidate to exit immediately. Pending/unknown submission confirmation never
starts this timer or clears recovery. Completion also stops camera/mic tracks and
audio processing. The portal offers authenticated receipt entry for
completed invitations and enforces minimum client 1.3.0. Simulated version-probe
tests do not establish actual archived-client detection or installer rollout.

Cold offline sign-in/paper bootstrap and OS power-loss durability remain outside
this section. See the [1C review checkpoint](implementation-review-1c-2026-11-19.md)
for evidence, exact repeat commands and pending visual acceptance.
