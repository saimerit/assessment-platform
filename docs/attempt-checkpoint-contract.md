# Attempt checkpoints — section 1B

Implemented 19 November 2026. The original 1B scope requires migration 11 and
desktop 1.2.0. Section 1C extends it with migration 12 and desktop 1.3.0; see the
[current submission, deadline and delivery contract](attempt-submission-contract.md).

Both adapters use the same lifecycle, answer validation, checkpoint storage and
submission services. Existing answer tables remain the source of candidate
responses. The API never reads the worker-only answer vault.

## Routes and authorization

| Operation | Event attempt | Legacy attempt |
| --- | --- | --- |
| Start or resume | POST `/api/exam/sessions/:session_id/start` | POST `/api/assessments/:blueprint_id/start` |
| Read checkpoint | GET `/api/exam/sessions/:session_id/checkpoint` | GET `/api/assessments/:blueprint_id/checkpoint` |
| Save batch | PUT `/api/exam/sessions/:session_id/checkpoint` | PUT `/api/assessments/:blueprint_id/checkpoint` |
| Submit durable snapshot | POST `/api/exam/sessions/:session_id/submit` | POST `/api/assessments/:blueprint_id/submit` |

Every route requires the candidate-bound attempt JWT and current organization,
candidate, registration, ownership and status checks. Checkpoint access additionally
requires verified unlock, a started attempt and a live stored deadline. A public
invitation or account JWT alone cannot read or write responses. GET
`/api/exam/identity` derives the recovery scope from the verified attempt credential.

## Save contract

```json
{
  "update_id": "0d51ccfe-72dc-4814-8c98-b0b20df2753a",
  "base_revision": 3,
  "answers": [
    {
      "question_id": "b8a153a4-1640-4639-8b1a-783e82b1f2f2",
      "selected_option_ids": [],
      "typed_response": "",
      "reviewed": true
    }
  ],
  "navigation": {
    "question_id": "b8a153a4-1640-4639-8b1a-783e82b1f2f2",
    "active_view": "question"
  }
}
```

Only changed answers are sent. An omitted question is unchanged, not cleared.
MCQ clearing uses `selected_option_ids: []` and `typed_response: null`.
FIB clearing uses empty text and no selected options. Missing FIB text normalizes
to empty text. A question without an answer row is also unanswered. The desktop
counts nonempty selections or trimmed, nonempty text only. Flags remain independent
of answered state.

The server validates each question against the pinned paper and each option
against its question. Wrong response types, duplicate questions/options, foreign
navigation, invalid identifiers and oversized requests fail without advancing the
revision. Limits: 100 changed questions per batch, 16 KiB per text response and
1 MiB route request bodies. The client also splits batches at approximately
512 KiB, beneath the route bound.

A successful response contains the full answer snapshot, `revision`,
`navigation`, `saved_at`, `started_at`, `timer_expires_at` and `server_time`.
Uninitialized checkpoints have revision zero and a null save timestamp.

Parent-attempt locking serializes writers. A matching revision advances once in
the same PostgreSQL transaction as answers, flags, navigation and the save receipt.
Retrying the same save ID and normalized payload returns the current snapshot
without another write. Reusing its ID with different data or using a stale base
returns HTTP 409 with `checkpoint`. The client journals the in-flight ID before
sending and retries it after an ambiguous response or process restart.

Independent question changes can rebase. A same-question mismatch between the
expected base and current server state requires an explicit candidate choice.
The UI shows the question and both response values. Choosing server responses
discards only the conflicting local changes; choosing local changes writes them
against the newly read revision. Other pending changes remain intact.

## Lifecycle and submission

First start persists the original start/deadline and paper/order. Resuming neither
regenerates the paper nor calculates another duration from current exam settings.
Started attempts can continue after the entry window closes, within the original
deadline. Time responses use consistent UTC timestamps. Migrated legacy attempts
use original instance creation time conservatively because the old client did not
store a start timestamp. Migration/restart never grants a fresh duration.

The desktop flushes pending changes, then submits `{ "checkpoint_revision": 4 }`.
The server finalizes that revision of the existing answer rows. Compatibility
answer payloads use the same ownership/type validation and preserve review flags.
Revision-only submission may finalize an already accepted snapshot after the
deadline; late answer updates and compatibility payload changes are rejected.

Section 1C now commits a stable receipt, frozen answers and grading outbox with
submitted state. Disconnected deadline finalization uses only server-accepted
responses; confirmation can be retrieved after expiry. The linked submission
contract supersedes the original 1B post-commit publication limitation. Worker
consumer retry/disconnect recovery remains 1D.

## Local recovery policy

Electron main encrypts the recovery journal using `safeStorage` (Windows DPAPI).
The encrypted envelope and hashed filename bind it to API origin, organization,
candidate, attempt kind and attempt ID verified against the server. Swapping a
file to another scope fails. Account/attempt tokens and grading keys are never
stored in the journal. Files are atomically replaced; writes and cleanup serialize.

The journal contains the last server snapshot, pending edits, navigation and any
in-flight save ID. Submission success deletes it. Expired files are pruned after
72 hours from their last write, at startup or read. The cap is 1 MiB per journal.
Unavailable OS encryption, corruption, wrong scope or size failures produce a
visible recovery warning; server saving can continue. Linux plaintext fallback is
refused. Cold restart needs connectivity for candidate sign-in and paper loading;
offline relaunch of a complete exam is not included. Unsaved edits are recoverable
once their local journal write completes; only server acknowledgment is labelled
“Saved to server.”
