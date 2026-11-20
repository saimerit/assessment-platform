# Section 1B — answer saving and recovery review

19 November 2026. Implementation, command verification and user visual review
complete. Section 1B is accepted. Section 1C is now implemented and awaiting its
separate [submission/receipt review](implementation-review-1c-2026-11-19.md).

## What changed

Event and legacy attempts share persisted start/resume/deadline rules and a
candidate-authorized checkpoint API. Answers, cleared/blank responses, review
flags and navigation save during the exam. Version checks and durable save IDs
prevent stale/duplicate writes. Electron encrypts unsent drafts and safely replays
them after reconnect/restart. Same-question conflicts show both values and require
an explicit choice. The desktop shows saving, saved, offline, retry, recovery and
conflict states. Client source/minimum compatibility is now 1.2.0.

Responsibilities remain separated: shared lifecycle/validation, answer repository
adapters, checkpoint controller, native encryption vault and reusable save-status
UI. Existing answer tables and the worker-only answer vault remain in use.
See the [API and recovery contract](attempt-checkpoint-contract.md).

## Completed command checks

- Disposable PostgreSQL/Redis tests pass for both adapters: access protection,
  ownership/type/option validation, saved/cleared/blank answers, flags/navigation,
  duplicate IDs, reused IDs, stale writes and simultaneous CAS writers.
- Resume keeps the original deadline/duration after the entry window closes and
  exam settings change. Fresh legacy generation excludes another organization's
  question bank and retains the generated paper on resume. Migration 11 reruns.
- All 17 client tests pass: eight credential tests and nine recovery-controller
  tests, including offline restart, ambiguous accepted responses, edits in flight,
  independent rebase, explicit conflicts, corrupt journals, storage failures,
  disposal races and bounded replay batches.
- Eight real Electron/Windows encryption checks pass: encrypted roundtrip,
  absence of plaintext, new-vault read, separate candidate scopes, copied-file
  rejection, 72-hour pruning, size limits and serialized writes/cleanup.
- Built desktop checks pass for event and legacy attempts: clearing and zero
  answered count, offline journal creation, actual Electron process exit/relaunch,
  isolated API restart, restored draft/flag/navigation and unchanged paper/timer,
  saving/error/retry states, live concurrent conflict selection, narrow/200% layout,
  revision-only submission and encrypted-buffer deletion. Seven scenario groups
  per execution model. Hardware/kiosk IPC are test doubles in this harness.
- Desktop type checks/production build and API production image build pass.

Evidence lives in the ignored isolated directory:
`C:\projects\DOA\assessment-platform\.attempt-access-review\6993480425c7`.
[Event results](../.attempt-access-review/6993480425c7/checkpoint-event-ui-results.json),
[legacy results](../.attempt-access-review/6993480425c7/checkpoint-legacy-ui-results.json)
and [native encryption results](../.attempt-access-review/6993480425c7/recovery-vault-results.json).
The database confirms both exercised attempts are SUBMITTED with two answer rows
each. The active review API is `http://127.0.0.1:50201`; the user's original platform was
not modified. Exercised sample attempts are submitted; use fresh fixtures for any
new live walkthrough.

## Five visual checks — accepted on 19 November 2026

The user replied **“All five look correct”** to the gallery review question covering
all five groups below. 1B-V1 through 1B-V5 and section acceptance 1B-R1 are checked
in the [feature checklist](feature-checklist.md). These are visual observations;
command verification remains recorded separately above. Original review estimate:
12–18 minutes. No additional manual crash/kiosk test or deployment is inferred.

The [review gallery](http://127.0.0.1:55587/checkpoint-review.html) is ready.
Its Codex preview was requested and queued; the link also opens it directly.
Select its screenshot links or scroll. The screenshots come from the built
renderer; disconnected/error transport is deliberately injected, while all
successful saves and conflicts use the real isolated API. No kiosk is active in
this gallery. Command behavior passed separately; the user's reply records visual
acceptance for all five groups below.

| Check | Where and what to check | Expected appearance | Estimate |
| --- | --- | --- | --- |
| 1B-V1 | **Saved answer**: answer, flag, green save card and last-save time | Clear labels and a readable answer; the timestamp describes server acknowledgment | 2–3 min |
| 1B-V2 | **Saving**, **Disconnected save**, **Save error** | The answer remains visible; status and Retry sync are readable; no overlapping controls | 3–4 min |
| 1B-V3 | **Recovered progress** | Restored draft, flagged state and recovery note are clear; the timer continues below 60 minutes | 2–3 min |
| 1B-V4 | **Conflicting responses** | Question title, device/server values and both choices are understandable | 2–3 min |
| 1B-V5 | **At 200% zoom**, plus the [narrow screenshot](../.attempt-access-review/6993480425c7/checkpoint-event-narrow.png) | Save information and Submit stay readable/reachable with vertical scrolling | 3–5 min |

All five review items passed based on the user's explicit response. Two earlier
1A observations remain open: Candidate Login listing visual review and actual archived 1.0.0
client detection. The archived build has no version probe; simulated update
warnings do not establish that detection or installer deployment. The user already
authorized progressing to 1B with that limitation open.

## Repeatable command setup

From `C:\projects\DOA\assessment-platform`:

```powershell
.\scripts\test-attempt-access.ps1
Push-Location .\lockdown-client
npm run build
Pop-Location
# With the isolated review API running the current source and migration 11:
.\scripts\test-checkpoint-review.ps1
.\scripts\open-checkpoint-review-gallery.ps1
```

The first command creates/removes disposable databases and does not overwrite the
active review manifest. The UI test helper creates distinct candidates/invitations
in the isolated review DB and restarts only its API between test processes. For a
fresh full isolated stack, `scripts/start-attempt-review.ps1` builds current source,
applies all migrations and creates a new manifest. Gallery URLs are local and change
when reopened; its latest URL/PID is saved in `checkpoint-gallery.json`.

For an optional actual desktop walkthrough, create fresh samples with
`scripts/new-checkpoint-review-fixtures.ps1`, read `checkpoint-fixtures.json`, then
open `scripts/open-attempt-review-client.ps1 -InvitationToken <event_invitation>`.
Use its synthetic candidate and `TestPassword123!`, then code `123456` (legacy
`654321`). Enter an answer and flag it; wait for Saved. Clear MCQ/blank text and
verify zero answered, then save another response. Relaunch while connected and
sign in: expect Resume, original timer, answers/flag/navigation. This actual client
enters kiosk when you engage the exam and requires submission/forfeit to exit;
the gallery avoids that requirement for visual review.

## Scope still pending

Cold restart requires network sign-in/paper loading. Local recovery is available
after its encrypted write completes; an encryption/storage failure visibly warns
the candidate. This checkpoint does not establish OS power-loss durability or
offline paper bootstrap. Section 1C subsequently added automatic deadline
finalization, a zero transport-grace policy, transactional grading delivery,
stable receipts and publisher recovery; see its linked contract/checkpoint.
Automatic worker consumer recovery remains 1D. Migration 11/client 1.2.0 were
this section's rollout requirements; 1C extends them to migration 12/client 1.3.0.
No installer/release or production deployment was published.

Current next action: review the completed 1C section before progressing to 1D.
Target rollout is explicitly deferred; the earlier 1A observations remain pending.
