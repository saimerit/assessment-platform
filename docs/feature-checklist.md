# Assessment platform feature checklist

Last updated: 20 November 2026.

Source: [assessment-platform-review-2026-11-19.md](C:/Users/sobha/.codex/visualizations/2026/11/18/01a1f096-54c8-74d2-a920-2cdde2296904/assessment-platform-review-2026-11-19.md).

This is the ongoing implementation tracker for the full review. Batch order comes
from that review; the sections within each batch arrange work around dependencies.
Vendor capabilities discussed as references are not automatically product commitments.

## How to update this file

- `[x]` means the stated implementation or check is complete. `[ ]` means work remains.
- **Baseline** means existing functionality reported in source, with end-to-end
  acceptance still to be established. It does not mean newly built or production verified.
- Implementation, automated verification, user review and deployment are separate
  items. A checked feature does not automatically approve its section or release.
- Keep item IDs stable. Update the relevant checkboxes, section status, next action
  and history after each section. Record partial work in a note and leave its box open.
- Link completed sections to their implementation/review notes and test evidence.
  Do not check acceptance until the user has reviewed it or explicitly waived review.
- Follow dependencies before starting an item. Stop after each agreed feature
  section, provide exact test steps and wait for review before continuing implementation.
- Use shared domain rules, focused services and reusable UI components. Preserve
  organization isolation and the worker-only answer vault throughout the work.
- Conditional and deferred items stay open until selected and implemented; they
  are not blockers for unrelated release scopes.

## Current position and next action

| Section | Priority / scope | Status | Dependency |
| --- | --- | --- | --- |
| Existing MVP | Baseline | Present in source; journeys need acceptance | Reference inventory below |
| 1A: attempt access | P0 | Implemented; next-section progress authorized; legacy detection remains open | Completed observations recorded below |
| 1B: autosave and recovery | P0 | Implemented, command-verified and user accepted | Candidate-bound access; shared attempt lifecycle |
| 1C: delivery and finalization | P0 | Implemented, command-verified and user accepted | Accepted 1B persisted answers; atomic outbox and pinned grading |
| 1D: worker recovery | P1 finding required by Batch 1's gate | Implemented, command-verified and user accepted | Accepted 1C delivery contract and idempotent submissions |
| Batch 2: dependable pilot | Pilot reliability and complete journeys | Pending | Full Batch 1 gate |
| Batch 3: both market segments | Broader roles, membership and question formats | Pending | Dependable core; membership before cross-organization workflows |
| Batch 4: integrations and expansion | Demand-led expansion | Pending | Relevant product workflows, permissions and delivery guarantees |

**Completed 1D review:** [implementation, evidence and four accepted review groups](implementation-review-1d-2026-11-19.md).

**1D work:** [worker contract](worker-recovery-contract.md) and
[verified checkpoint](implementation-review-1d-2026-11-19.md). Shared runtime,
lease/budget storage, quorum retry/DLQ routing, automatic reconnect and private
health are implemented. Five runtime tests, two SMTP tests, both-model DB/grading
tests, 29 client tests/type checks, image/Compose builds, eight live groups and the
readout checks pass. The user accepted all four review groups on 20 November
2026. Deployment remains separate and explicitly deferred.

**Completed review:** [1B implementation, evidence and accepted visual checks](implementation-review-1b-2026-11-19.md).

**Latest evidence:** 1C pins content/keys/policy, commits frozen responses,
submission and outbox atomically, retries confirmed publication, finalizes
disconnected deadlines and exposes stable receipts. Both-adapter PostgreSQL/Redis
and frozen grading tests, 29 client service tests, six live delivery groups, nine
built-desktop groups, two real one-minute automatic application closes, two
candidate privacy checks, focused scrolled/200% checks, three gateway scenarios and
builds passed. The 1C test manually restarted its grader; 1D now separately verifies
automatic recovery of both consumers. See the current checkpoint for evidence
and limitations, including historical snapshots and the portal dependency advisory.

**User acceptance:** On 19 November 2026, the user replied **“All five look
correct”** to the five 1B visual review groups. 1B-V1 through 1B-V5 and the section
review gate 1B-R1 are complete. This records gallery visual acceptance alongside
the existing command evidence; it does not claim additional manual crash/kiosk
tests or deployment approval.

The user approved 1A's gateway/schedule refinement and remaining wrong-account/
loading screenshots, then explicitly authorized remaining work and section 1B.
The 960-second native renewal run previously passed 33 authorized paper checks,
three credentials and submission with two saved answers. Candidate Login listing
visual review and actual archived-client detection remain open in 1A. The available
1.0.0 archive has no version probe; its simulated warning does not establish actual
detection or installer rollout.

**Latest review correction:** The user requested submission-only confirmation,
one-minute application close and confidential results. The receipt and candidate
portal no longer disclose grading or scores. Native close tests pass at about
60 seconds for both models. Evaluator publication and optional email delivery
remain unchecked in 3F; successful grading never releases results.

**1C acceptance:** The user replied “Yes thats good now next section” to the
revised six-group review. 1C-V1–V6 and 1C-R1 are accepted for that visual scope.
Command verification remains separate; no deployment approval is inferred.

**1D acceptance:** On 20 November 2026, the user replied “Yes” to the four-group
review. 1D-V1–V4 and 1D-R1 are complete for that visual/readout scope. This does
not infer another manual outage test, combined Batch 1 acceptance or deployment.

**Next action:** Await continuation at the accepted 1D boundary. Section 2A (data
access, contracts and performance) is next in the roadmap; the combined Batch 1
review gate G1-05 and earlier 1A observations remain open. The user explicitly deferred
deployment while other sections remain to build. Installer publishing, target
migrations and rollout stay unchecked.

## Existing MVP inventory

Checked items in this section are **Baseline**, as described in the original
source review. The later sections track their missing capabilities and validation.

- [x] BASE-01 — Organizations, five account roles, JWT sign-in and organization filters on management queries.
- [x] BASE-02 — Org Admin dashboard and organization-owned question banks.
- [x] BASE-03 — Individual and bulk question authoring, difficulty and marks.
- [x] BASE-04 — MCQ, multiple selected options and fill-in-the-blank responses.
- [x] BASE-05 — Fixed and randomized paper sets; persisted per-candidate papers.
- [x] BASE-06 — Assessment events, candidate assignments, proctor assignments and code rotation.
- [x] BASE-07 — Organization registration invitations and separate assessment invitations.
- [x] BASE-08 — Candidate registration, sign-in, assigned exam schedules and score display.
- [x] BASE-09 — Browser reminders while the candidate portal remains open.
- [x] BASE-10 — Proctor assignment views, passcodes and incident lists with polling.
- [x] BASE-11 — Desktop invitation deep links, version probe and hardware checks.
- [x] BASE-12 — Desktop server timer, question/section overview, navigation and review flags.
- [x] BASE-13 — Final submission and desktop incident reporting; access hardening completed in 1A.
- [x] BASE-14 — Worker-only answer vault, objective grading and result upserts.
- [x] BASE-15 — MCQ subset partial credit without wrong options; trimmed, optionally case-sensitive text grading.
- [x] BASE-16 — Next.js portal, Go API, PostgreSQL, Redis, RabbitMQ and separate grading/notification workers.
- [x] BASE-17 — Same-origin Caddy gateway, local startup/migrations and non-root production application images.

## Batch 1 — exam safety

### 1A — attempt authorization and bypass closure

Status: **implemented; progression authorized; Candidate Login listing and actual archived-client detection remain open**. Evidence and manual steps:
[1A review checkpoint](implementation-review-2026-11-19.md).

- [x] 1A-01 — Exchange an authenticated candidate identity and assigned invitation for a short-lived attempt token.
- [x] 1A-02 — Bind token to candidate, organization, event/blueprint, session/invitation and allowed operations.
- [x] 1A-03 — Apply one access service and repository interface to event and legacy route adapters.
- [x] 1A-04 — Enforce unlock-before-start on the server; close legacy public start bypasses.
- [x] 1A-05 — Recheck current candidate ownership, organization, role, registration and attempt status on requests.
- [x] 1A-06 — Authenticate incidents; derive candidate/event identity server-side and reject spoofed associations.
- [x] 1A-07 — Rate-limit login, access exchange, unlock and incident ingestion; return retry guidance.
- [x] 1A-08 — Fail closed when access-check dependencies are unavailable; bound relevant request bodies.
- [x] 1A-09 — Separate portal account tokens from narrowly scoped attempt credentials.
- [x] 1A-10 — Share one in-memory desktop credential client with automatic renewal and authenticated native telemetry.
- [x] 1A-11 — Reuse candidate sign-in UI for invitation and account entry; prevent stale credential restoration.
- [x] 1A-12 — Persist verified unlock state through a repeatable migration; require reverification for old legacy instances.
- [x] 1A-13 — Raise desktop source/minimum compatibility version to 1.1.0, retaining higher configured requirements.
- [x] 1A-14 — Pass focused API, real PostgreSQL/Redis integration and eight desktop credential tests.
- [x] 1A-15 — Pass desktop type checks/build and document migration/client rollout requirements.
- [x] 1A-16 — User-requested shared show/hide control for desktop password, passcode and invitation fields, with animated eye, accessible labels/focus and reduced-motion support.
- [x] 1A-17 — User-requested consistent light gateway styling and responsive schedule dashboard with shared paper metrics/table; desktop/portal builds and native narrow/200% checks pass.
- [x] 1A-R5 — User approves the matching gateway theme and schedule dashboard/card/table layout; narrow/200% zoom and continue behavior are separately command-verified.
- [ ] 1A-R1 — Complete actual desktop sign-in, wrong-account/code, legacy and 16-minute renewal walkthrough.
- [x] 1A-R1a — User confirms corrected sign-in reaches the expected schedule/paper-pattern screen and candidate-details action.
- [x] 1A-R1b — User confirms candidate-details/honor-code/hardware flow and wrong-code correction followed by valid-code outline access.
- [x] 1A-R1c — User confirms fullscreen exam entry, paper loading and timer/navigation; server confirms successful start/questions/submission and two saved answers.
- [x] 1A-R1d — User confirms legacy invitation sign-in, wrong-code correction and valid-code outline access.
- [x] 1A-R1e — Real 16-minute native-renderer renewal/submission check passes with unchanged paper/timer and SUBMITTED state/two saved answers.
- [x] 1A-R1f — Command-driven built desktop UI rejects other candidate, other organization and staff accounts with cleared password and no schedule access.
- [x] 1A-R1g — Command-driven Candidate Login lists assigned exam and reaches schedule with exactly one sign-in.
- [ ] 1A-R1h — User reviews the Candidate Login listing screen; wrong-account visual review was confirmed and recorded in 1A-R2f.
- [ ] 1A-R2 — Review keyboard navigation, errors, loading behavior and 200% zoom in the actual desktop UI.
- [x] 1A-R2a — User confirms password eye animation, show/hide behavior and keyboard toggling without form submission.
- [x] 1A-R2b — Review visibility controls for passcode/invitation fields and automatic remasking after clearing or submission.
- [x] 1A-R2c — User confirms the passcode eye control works during the pre-exam walkthrough.
- [x] 1A-R2d — User confirms Tab focus and 200% zoom keep labels, errors and buttons readable and reachable with scrolling.
- [x] 1A-R2e — Built desktop loading check disables password/submit, suppresses five repeated submissions and restores controls after rejection.
- [x] 1A-R2f — User confirms the wrong-account error/retry and loading/disabled-control screenshots are clear; behavior separately command-verified.
- [ ] 1A-R4 — Verify actual old-client update prompt; archived 1.0.0 has no probe, while simulated warning/fallback pass. Installer publishing remains separate deployment work.
- [x] 1A-R3 — User authorizes continuing the remaining work and section 1B; unresolved actual old-client detection stays open in 1A-R4, without claiming a pass or deployment acceptance.

Review note: command-side password/account/code rejection, legacy bypass closure,
start timing, telemetry and deterministic token renewal passed through the live API.
The actual client opened with candidate A's email and visible form controls. 1A-R1
and 1A-R2 remain open until their complete user walkthroughs are recorded. The
reported browser fetch receiver error was reproduced and corrected; six native
renderer checks passed, and the user confirmed the corrected sign-in/schedule step.
The passcode field was moved to the tutorial verification screen so rejected codes
can be edited and retried there. Type checks/build passed; the user confirmed
candidate details, honor code, hardware checks and wrong/valid code behavior.
The shared sensitive-field control was added at the user's request; its type
checks/build passed. The user approved the password eye transition and keyboard
toggle and passcode eye, followed by invitation/password remasking and Tab/200% zoom.
The user completed exam entry and submitted. Logs distinguish intentional wrong
password/code rejections from successful execution. Next: command-driven elapsed
renewal, remaining agreed checks and section acceptance; the user has said continue.
The interrupted native renewal run is incomplete, not a passed expiry check. Its
process was stopped intentionally; the runner's nonzero exit reflects that stop.

### 1B — durable answers, cleared responses and recovery

Status: **implemented, command-verified and user accepted on 19 November 2026**.
Depends on 1A. Both execution models use shared lifecycle, validation and storage
rules. Evidence, scope and review steps: [1B checkpoint](implementation-review-1b-2026-11-19.md).

- [x] 1B-01 — Share lifecycle, start/resume and authoritative deadline rules across event and legacy attempts.
- [x] 1B-02 — Define the answer/checkpoint/recovery API contract and explicit unanswered state.
- [x] 1B-03 — Persist changed answers in PostgreSQL during the attempt, under attempt authorization.
- [x] 1B-04 — Use versioned/idempotent answer updates; handle duplicates, stale writes and concurrent requests safely.
- [x] 1B-05 — Validate paper/question/option ownership and response type for every saved batch.
- [x] 1B-06 — Support clearing a previously saved MCQ response and blanking a typed response durably.
- [x] 1B-07 — Count only nonempty responses; allow unanswered questions without malformed submission payloads.
- [x] 1B-08 — Persist and restore review flags alongside answers.
- [x] 1B-09 — Keep a protected local recovery buffer scoped to candidate/attempt; define its cleanup policy.
- [x] 1B-10 — Replay unsynchronized changes in a safe version order after reconnect without overwriting newer accepted work.
- [x] 1B-11 — Restore answers, review flags and useful navigation state after client restart.
- [x] 1B-12 — Restore the original paper/order and server timer without resetting an attempt on resume.
- [x] 1B-13 — Show saving/saved/offline/syncing/error states and the last server-acknowledged save.
- [x] 1B-14 — Test cleared/blank answers, stale batches, duplicate writes and cross-candidate answer access.
- [x] 1B-15 — Test crash, reconnect and API/client restart; recover every acknowledged answer.
- [x] 1B-16 — Add explicit already-unlocked resume without a renewed access code, and readable conflicting response values.
- [x] 1B-17 — Document migration 11 and source/minimum client version 1.2.0, retaining higher configured requirements.
- [x] 1B-A1 — Pass disposable PostgreSQL/Redis lifecycle/checkpoint tests for both adapters, including a fresh organization-scoped legacy paper.
- [x] 1B-A2 — Pass 17 credential/recovery-controller tests and eight native encrypted-vault checks.
- [x] 1B-A3 — Pass built desktop restart/reconnect/conflict/submission checks for event and legacy attempts; inspect saving/error/narrow/200% screenshots.
- [x] 1B-A4 — Pass desktop type checks/production build, API production image build and whitespace check.
- [x] 1B-R0 — Provide the linked checkpoint, five visual checks and runnable screenshot gallery; Codex preview requested (queued).
- [x] 1B-V1 — User reviews Saved to server, the timestamp, typed response and review flag.
- [x] 1B-V2 — User reviews Saving, Offline and Save error states and readable Retry sync controls.
- [x] 1B-V3 — User reviews restored draft, flag/navigation, recovery note and continuing timer.
- [x] 1B-V4 — User reviews question/device/server values and explicit conflict choices.
- [x] 1B-V5 — User reviews narrow/200% layout, scrolling and reachable primary controls.
- [x] 1B-R1 — Receive section acceptance after the targeted visual checks; user replied “All five look correct” on 19 November 2026.
- [ ] 1B-D1 — Apply migration 11 in the target deployment and roll out the matching API.
- [ ] 1B-D2 — Publish/distribute the compatible 1.2.0 installer and release record.

Recovery scope note: restart needs online sign-in/paper loading; unsent edits need
a completed encrypted local write. A visible warning covers unavailable encryption,
corrupt/oversized journals. Section 1C now adds automatic deadline finalization,
zero transport grace for edits, stable receipts and durable publisher recovery;
automatic worker consumer recovery remains 1D. See the
[current submission contract](attempt-submission-contract.md).

### 1C — transactional delivery, deadline finalization and receipts

Status: **implemented, command-verified and user accepted,
deployment deferred**. Depends on accepted 1B. Both adapters share the atomic
submission/outbox and pinned grading contract. Evidence and exact steps:
[1C review checkpoint](implementation-review-1c-2026-11-19.md) and
[submission contract](attempt-submission-contract.md).

- [x] 1C-01 — Define a submission/version identity and a durable grading-event outbox contract.
- [x] 1C-02 — Save submission and outbox record in one PostgreSQL transaction for both execution models.
- [x] 1C-03 — Dispatch jobs with publisher confirms, retry/backoff and broker reconnect recovery.
- [x] 1C-04 — Deduplicate delivery and grading by submission/version.
- [x] 1C-05 — Pin the exact published question content, order and scoring policy used by an attempt.
- [x] 1C-06 — Freeze edits at the server deadline and reject late answer changes.
- [x] 1C-07 — Finalize expired attempts from the last server-accepted answer snapshot, including when clients disconnect.
- [x] 1C-08 — Specify the transport grace policy explicitly; ignore arbitrary client timestamps for eligibility.
- [x] 1C-09 — Make finalization idempotent under double submit, concurrent requests and retries.
- [x] 1C-10 — Persist stable submission receipts and authorize retrieval after submission/expiry.
- [x] 1C-11 — Show finalization/retry/receipt state without losing or misrepresenting submitted work.
- [x] 1C-12 — Test just-before, exact and after-deadline behavior; unanswered questions and double submit.
- [x] 1C-13 — Test broker outage during/after commit, dispatcher restart and repeated delivery.
- [x] 1C-V1 — User reviews unknown submission confirmation and retry message.
- [x] 1C-V2 — User reviews receipt counts/time, 60-second close countdown and immediate Exit, with no grading status or score disclosures.
- [x] 1C-V3 — User reviews receipt ID selection and reopened receipt details.
- [x] 1C-V4 — User reviews deadline pending state and accepted-response receipt explanation.
- [x] 1C-V5 — User reviews both narrow/200% layouts and scrolled reachable actions.
- [x] 1C-V6 — User reviews the submitted-invitation gateway and receipt-entry action.
- [x] 1C-R1 — Provide targeted review steps and receive section acceptance.
- [ ] 1C-D1 — Apply target migration 12 and distribute/publish the compatible client and services; explicitly deferred by the user.
- [x] 1C-14 — User-requested submission-only receipt, native one-minute close and immediate exit; remove candidate grading/score disclosures from receipt and schedule APIs/UI.
- [x] 1C-T14 — Verify private candidate API/portal responses, no grading wait, native timer deduplication/cancellation and real 60-second closure for both models; the revised visual review was accepted separately.

Scope note: new attempts pin at first start. Historical content/time that was not
recorded cannot be recreated; recovery from current definitions is labelled
RECOVERED_CURRENT, and saved historical results are preserved without regrading.
Zero transport grace excludes unsent late edits. Publisher recovery is verified;
the original 1C outage harness explicitly restarts its review worker. Automatic
consumer reconnect, bounded retries/DLQ and private health were subsequently
implemented, tested and accepted in 1D.

### 1D — worker retry and disconnect recovery

Status: **implemented, command-verified and user accepted on 20 November 2026**. The source labels worker resilience P1, while Batch 1's exit
gate requires retry recovery. Depends on 1C's submission/delivery contract.

Source/contract: [1D checkpoint](implementation-review-1d-2026-11-19.md).
Five shared-runtime tests, two SMTP tests, real DB/grading checks, 29 desktop
service checks, final builds and eight live recovery groups pass. SMTP remains
local in tests; successful production SMTP acceptance before a database commit
can still resend after a crash. Operator alert integrations/audited replay stay 2G.

- [x] 1D-01 — Add delayed retries and processing timeouts to grading and notification workers.
- [x] 1D-02 — Bound maximum attempts and route exhausted jobs to dead-letter queues.
- [x] 1D-03 — Rebuild broker connections, channels and consumers after runtime disconnects.
- [x] 1D-04 — Expose consumer health, queue age, failed processing and dead-letter alerts.
- [x] 1D-05 — Preserve idempotent effective results during redelivery and concurrent processing.
- [x] 1D-06 — Test poison jobs, timeouts, disconnects, restart and redelivery without immediate requeue loops.
- [x] 1D-V1 — User reviews healthy worker names, Ready labels and test/production policy note.
- [x] 1D-V2 — User reviews retry/timeout ages, leased work and explicit Unknown metadata.
- [x] 1D-V3 — User reviews Not ready/Ready recovery and connection counts.
- [x] 1D-V4 — User reviews dead-letter attention, passed evidence and table/focus access at 200%.
- [x] 1D-R1 — Provide targeted review steps and receive section acceptance.
- [ ] 1D-D1 — Apply target migration 13 and roll out matching workers/private health; user-deferred deployment.

### Batch 1 exit gate

- [x] G1-01 — Unauthorized and cross-organization execution, answer access and telemetry tests pass.
- [x] G1-02 — Deadline boundaries, cleared/unanswered responses and repeated finalization tests pass.
- [x] G1-03 — No acknowledged answers are lost in the scoped, tested crash/restart/reconnect scenarios; offline paper bootstrap and OS power-loss durability remain outside this claim.
- [x] G1-04 — Stable receipts and one effective result per submission/version survive the tested broker failure and redelivery scenarios.
- [ ] G1-05 — Section reviews and the combined candidate journey are accepted before progressing to Batch 2.

## Batch 2 — dependable pilot

### 2A — data access, API contracts and performance

Depends on Batch 1. Measure with representative papers/data before tuning.

- [ ] 2A-01 — Replace per-question option queries with joined/batched paper loading in both adapters.
- [ ] 2A-02 — Close pooled result sets before subsequent queries; efficiently validate/upsert answer batches.
- [ ] 2A-03 — Add server pagination/filtering to candidates, banks/questions, events, invitations and results.
- [ ] 2A-04 — Investigate slow queries with EXPLAIN ANALYZE and add justified indexes.
- [ ] 2A-05 — Budget database pools across API replicas/workers and apply query/transaction timeouts.
- [ ] 2A-06 — Document shared API statuses/request shapes and generate a typed client to prevent contract drift.
- [ ] 2A-07 — Organize backend domains around identity/membership, content, events, attempts, proctoring and results.
- [ ] 2A-R1 — Review query/pagination behavior, measured performance and section acceptance.

### 2B — account lifecycle, organization basics and role navigation

Depends on Batch 1. Full cross-organization membership and delegated permission
expansion belong to 3A; the pilot must still have effective current-role checks.

- [ ] 2B-01 — Replace portal localStorage credentials with secure HttpOnly cookie sessions and an appropriate CSRF policy.
- [ ] 2B-02 — Add account/session refresh, revocation and effective server-side logout.
- [ ] 2B-03 — Add password recovery/reset and profile management.
- [ ] 2B-04 — Add staff MFA and make staff role/access changes effective for existing sessions.
- [ ] 2B-05 — Complete organization profile, branding and default time zone administration.
- [ ] 2B-06 — Complete owner provisioning and staff invitation/access lifecycle using the supported permission model.
- [ ] 2B-07 — Provide coherent navigation for Admin, Proctor, Candidate, Instructor/Recruiter and Super Admin.
- [ ] 2B-08 — Define usable Instructor/Recruiter permissions and provide a dedicated scoped authoring workflow.
- [ ] 2B-09 — Make search, notifications, Settings and Help controls work and lead to their intended destinations.
- [ ] 2B-10 — Show the candidate's next required action prominently, with an accessible help route.
- [ ] 2B-R1 — Review sign-in/reset/logout/permission-change and role-navigation journeys.

### 2C — guided assessment and invitation lifecycle

Depends on 2B's access policies and 1C's immutable attempt content/delivery rules.

- [ ] 2C-01 — Build a saved-draft assessment wizard with purpose/template, content and step validation.
- [ ] 2C-02 — Configure timing, scoring, permitted resources, AI-use rules, proctoring policy and accommodations.
- [ ] 2C-03 — Select audience, preview the complete candidate experience and publish deliberately.
- [ ] 2C-04 — Support draft, clone, version, pre-publication edit and archive.
- [ ] 2C-05 — Support cancel/reschedule and controlled, audited post-publication changes.
- [ ] 2C-06 — Add validated bulk candidate imports and clear duplicate handling.
- [ ] 2C-07 — Bring organization registration and exam assignment into one guided flow while keeping their operations distinct.
- [ ] 2C-08 — Add candidate groups, departments/cohorts and eligibility management within supported organization scope.
- [ ] 2C-09 — Track invited, checked-in, ready, started, disconnected, submitted, grading, reviewed and published event states.
- [ ] 2C-10 — Assign proctors/graders with room/group scope, workload visibility and escalation handling.
- [ ] 2C-11 — Handle late entry, no-shows, retake eligibility and approved retakes under a defined policy.
- [ ] 2C-12 — Separate Start/Resume gateway actions and share the full status contract.
- [ ] 2C-13 — Verify relaunch inside/outside the invitation window while the authoritative attempt duration remains valid.
- [ ] 2C-14 — Add a practice/sample exam before the assessed clock starts.
- [ ] 2C-15 — Present exam time zone, duration, desktop/OS requirements, resources and AI policy clearly during onboarding.
- [ ] 2C-R1 — Review admin creation/import/invitation and candidate onboarding/practice journeys.

### 2D — dependable invitations and reminders

Depends on 1C outbox and 1D notification retry recovery.

- [ ] 2D-01 — Extend transactional outbox delivery to registration/exam invitations and reminders.
- [ ] 2D-02 — Restrict explicit mock delivery to development; require configured authenticated delivery in production.
- [ ] 2D-03 — Distinguish queued, sent, delivered, bounced and failed states instead of marking mock sends as SENT.
- [ ] 2D-04 — Show delivery status and provide controlled resend/reminder actions.
- [ ] 2D-05 — Add reliable email/calendar reminders; keep browser reminders supplementary.
- [ ] 2D-06 — Test failures, duplicates, bounces, retries and resend behavior with the chosen delivery service.
- [ ] 2D-R1 — Review recipient experience and administrator delivery operations.

### 2E — operational proctor support and required monitoring mode

Depends on current event/room permissions and authenticated attempt telemetry.
Media items are required before a pilot advertised as online proctored; choose and
validate the actual monitoring/record-and-review mode before representing it as available.

- [ ] 2E-01 — Remove the seeded blueprint context; selected assigned event becomes the sole proctor context.
- [ ] 2E-02 — Add assigned-event calendar/roster, attendance, check-in, identity review and hardware readiness status.
- [ ] 2E-03 — Show real-time presence, connection/disconnection and reconnect state.
- [ ] 2E-04 — Use event snapshots plus incremental presence/incident/result updates with backoff and bounded polling fallback.
- [ ] 2E-05 — Prevent overlapping refreshes and preserve filters, selection, focus and scroll during updates.
- [ ] 2E-06 — Provide candidate help requests and escalation to the administrator.
- [ ] 2E-07 — Add an incident queue with severity, timestamps, evidence, acknowledgement, notes and disposition.
- [ ] 2E-08 — Select the required online monitoring/record-and-review policy and candidate/proctor capacity limits.
- [ ] 2E-09 — Integrate the selected camera/screen media mode using a proven media service/SFU, separately from control APIs.
- [ ] 2E-10 — Authorize media access by organization/event/assignment and store recording/evidence metadata and assets appropriately.
- [ ] 2E-11 — Load media views on demand; validate reconnect, review availability and the selected recording/evidence policy.
- [ ] 2E-R1 — Review assigned-event operations and the complete selected monitoring mode before an online-proctored pilot.

### 2F — shared UI and accessibility

Apply these standards while implementing each earlier section; the final audit
checks the complete pilot rather than postponing all UI work until this point.

- [ ] 2F-01 — Standardize reusable fields, tables, buttons, dialogs, badges, notifications and spacing.
- [ ] 2F-02 — Provide consistent empty/loading/error states and comfortably readable ordinary text, generally 14–16px.
- [ ] 2F-03 — Add consistent read cancellation, query caching, error handling and bounded retry behavior.
- [ ] 2F-04 — Keep writes idempotent where retried; prevent user-specific cached data leaking across organizations.
- [ ] 2F-05 — Preserve search/filter state in URLs and use server-rendered portal content where appropriate.
- [ ] 2F-06 — Distinguish single-answer/multiple-answer controls; verify palette, sections, flags and unanswered counts.
- [ ] 2F-07 — Verify keyboard/focus behavior, dropdown/listbox semantics, modal focus containment and screen-reader labels.
- [ ] 2F-08 — Verify contrast, reduced motion, supported accommodations, mobile onboarding and 200% desktop zoom against WCAG 2.2 AA.
- [ ] 2F-09 — Resolve portal lint failures and enforce the applicable UI checks in CI.
- [ ] 2F-10 — Measure mobile/desktop Core Web Vitals against the review's LCP, INP and CLS targets.
- [ ] 2F-R1 — Review complete role journeys for readable, accessible and stable interactions.

### 2G — deployment, distribution, CI and operational visibility

Depends on the reliable attempt/delivery engine; source compatibility changes in
1A do not count as a published installer or a production migration runner.

- [ ] 2G-01 — Package trusted desktop runtime configuration so candidates do not set environment variables.
- [ ] 2G-02 — Build signed installers and a signed/update distribution workflow for supported operating systems.
- [ ] 2G-03 — Publish the available client release/download record and validate minimum-version/update behavior.
- [ ] 2G-04 — Verify installed-client detection/deep links under actual production CSP and supported browsers, with a clear fallback.
- [ ] 2G-05 — Add tracked production/local migrations, compatible rollout/rollback and tested database backup restoration.
- [ ] 2G-06 — Add dependency readiness, HTTP/request deadlines, graceful shutdown and remaining endpoint/payload limits.
- [ ] 2G-07 — Add structured request/job IDs and metrics for latency/errors, save acknowledgements, pool waits and reconnects.
- [ ] 2G-08 — Monitor delivery failures, worker/consumer health and queue age; connect 1D alerts to operator workflows.
- [ ] 2G-09 — Provide Super Admin service/queue health, delivery failures, dead-letter inspection/replay and release status views.
- [ ] 2G-10 — Add CI for relevant behavior/integration tests, type checks, lint, builds and migration compatibility.
- [ ] 2G-R1 — Review release, rollback, restore and operator recovery procedures.

### Batch 2 exit gate and measured launch targets

Define paper sizes, request patterns, network delay/loss, instance sizing and
database capacity first. Targets are proposed benchmarks, not achieved capacity.

- [ ] G2-01 — Admin, Proctor, Candidate and scoped Instructor/Recruiter journeys pass end to end.
- [ ] G2-02 — Production gateway, desktop release, delivery service and required monitoring mode pass acceptance.
- [ ] G2-03 — Validate 500 concurrent candidates including concentrated start, autosave and submit bursts.
- [ ] G2-04 — Measure metadata/list API p95 below 300ms with bounded page sizes.
- [ ] G2-05 — Measure autosave acknowledgement p95 below 500ms under the agreed network profile.
- [ ] G2-06 — Measure authorized paper delivery p95 below 1 second for the agreed paper size.
- [ ] G2-07 — Measure objective grading p95 below 10 seconds at the target workload.
- [ ] G2-08 — Validate acknowledged-answer recovery, stable receipts and one effective result per submission/version at load.
- [ ] G2-09 — Validate API/client restart, network interruption, broker outage and redelivery under the agreed load.
- [ ] G2-10 — Validate media workload/proctor roster capacity separately from candidate control-API concurrency.
- [ ] G2-11 — Receive pilot acceptance within the explicitly supported question/proctoring scope.

## Batch 3 — academic/certification and hiring coverage

### 3A — membership and fuller organization/platform permissions

Build this foundation before multi-organization candidate flows, delegated
administration or support access that depends on membership scope.

- [ ] 3A-01 — Separate account identity, organization membership and assessment participation.
- [ ] 3A-02 — Support candidates joining multiple organizations without creating duplicate identities.
- [ ] 3A-03 — Allow organization invitations for existing registered candidates.
- [ ] 3A-04 — Preserve an accountable organization owner while supporting delegated staff permissions.
- [ ] 3A-05 — Define scoped role/permission assignment and revocation for authors, proctors, graders and reviewers.
- [ ] 3A-06 — Keep assessments, results, media, invitations and reports isolated between employers/institutions.
- [ ] 3A-07 — Add platform quotas, feature entitlements and organization configuration administration.
- [ ] 3A-08 — Add purpose-bound, audited support access and operational audit history.
- [ ] 3A-R1 — Review membership, delegated access and cross-organization isolation tests.

### 3B — authoring, templates and assessment policy

Depends on content/scoring pinning from 1C and appropriate author permissions.

- [ ] 3B-01 — Add rich text, mathematics and media question content with preview.
- [ ] 3B-02 — Add question versions, review/approval, change history and reusable assessment templates.
- [ ] 3B-03 — Add own/shared banks, tags, skills/learning outcomes and validated richer imports.
- [ ] 3B-04 — Generate balanced forms by topic/skill, difficulty, type and marks constraints.
- [ ] 3B-05 — Randomize options while persisting exact question/option order for each attempt.
- [ ] 3B-06 — Add configurable scoring/partial-credit policies and pass rules with understandable candidate/reviewer rules.
- [ ] 3B-07 — Extend accommodations and configurable assessment policies across the supported formats.
- [ ] 3B-R1 — Review author permissions, content versions, form balancing and scoring consistency.

### 3C — academic formats and evaluator/reviewer workflow

Depends on secure answer/file storage, marking permissions, pinned policy and
reliable submission/result delivery. These precede academic publication workflows.

- [ ] 3C-01 — Add essays/written answers and supported candidate uploads.
- [ ] 3C-02 — Add an explicit evaluator/reviewer permission set and assigned marking queue.
- [ ] 3C-03 — Support anonymous/blind marking when the assessment policy requires it.
- [ ] 3C-04 — Add rubrics, per-question feedback and manual grading.
- [ ] 3C-05 — Add optional second marking, collaborative grading and moderation.
- [ ] 3C-06 — Add regrading and an auditable grade-change history.
- [ ] 3C-07 — Review incidents independently of score calculation and apply result approval/publication policy.
- [ ] 3C-R1 — Review an essay/upload assessment from candidate submission through marking/moderation.

### 3D — hiring skills and isolated practical tasks

Depends on authoring/scoring policy and reliable attempt execution. Coding
execution must be isolated from the API and grading database before exposing it.

- [ ] 3D-01 — Add role/skill-based assessment templates and competency scorecards.
- [ ] 3D-02 — Add selected scenario/job-simulation and communication question formats supported by customer needs.
- [ ] 3D-03 — Add isolated coding/debugging tasks and the required candidate editor/test experience.
- [ ] 3D-04 — Enforce CPU, memory and execution time limits with restricted network access in the coding service.
- [ ] 3D-05 — Grade practical tasks and report skills clearly under the pinned scoring policy.
- [ ] 3D-R1 — Review a complete hiring workflow and coding service isolation/resource-limit tests.

### 3E — proctor communication, interventions and evidence review

Depends on membership/room permissions, server timer policy and the selected media
and incident infrastructure. Signals support human review and correction.

- [ ] 3E-01 — Add individual chat, broadcast announcements and candidate help communication.
- [ ] 3E-02 — Add audited warnings, pause/resume and a defined server timer-during-pause policy.
- [ ] 3E-03 — Add approved extra time and audited termination actions.
- [ ] 3E-04 — Add escalation, reconnect handling, reassignment and proctor handover.
- [ ] 3E-05 — Add contextual evidence review and a way to correct false-positive incidents.
- [ ] 3E-06 — Add end-of-event review and signed-off integrity/incident reports.
- [ ] 3E-R1 — Review communication, intervention authorization, timer effects and incident dispositions.

### 3F — results, publication and candidate follow-up

Depends on pinned scoring, assigned marking/moderation where applicable and
organization-scoped permissions. Share the underlying result service across segments.

- [ ] 3F-01 — Add section/skill score breakdowns and academic learning-outcome reports.
- [ ] 3F-02 — Add understandable scorecards and candidate comparison for the permitted organization scope.
- [ ] 3F-03 — Build evaluator-confirmed publication of results/feedback, with confidential defaults and selected candidate portal/email release; internal grading does not imply candidate visibility.
- [ ] 3F-04 — Add CSV/PDF exports and report/result audit history.
- [ ] 3F-05 — Add candidate appeal and retake request/approval flows.
- [ ] 3F-07 — Add optional result email delivery only after explicit publication, using the durable notification delivery path; allow recruitment results to remain confidential.
- [ ] 3F-R1 — Review result visibility, publication, exports, appeals and retakes for every relevant role.

### Batch 3 exit gate

- [ ] G3-01 — At least one academic/certification journey passes with real users.
- [ ] G3-02 — At least one hiring journey passes with real users.
- [ ] G3-03 — Validate multi-organization isolation, marking permissions, coding boundaries and intervention audit trails.
- [ ] G3-04 — Receive acceptance for the supported market/question-format scope before expansion.

## Batch 4 — integrations and expansion

Select these against demonstrated customer needs. Each integration depends on
the relevant workflows, identity/permission model and reliable delivery contract.

- [ ] 4-01 — Add LMS/LTI integration and validate course/user/assessment mapping.
- [ ] 4-02 — Add SIS workflows and validate academic roster/result synchronization.
- [ ] 4-03 — Add ATS integration for hiring assessment assignment and results.
- [ ] 4-04 — Add authenticated webhooks with idempotency, retry/replay and scoped payloads.
- [ ] 4-05 — Add SSO with explicit organization/membership mapping and access revocation.
- [ ] 4-06 — Add multilingual interface/content and validated locale/time-zone behavior.
- [ ] 4-07 — Add certificate issuance under the approved result/publication policy.
- [ ] 4-08 — Add item/skill analytics using versioned assessments and appropriate organization/report permissions.
- [ ] 4-09 — Validate larger workloads with measured API, worker, database and media operating cost.
- [ ] G4-01 — Validate workflow correctness, data isolation and recovery for each selected integration.
- [ ] G4-02 — Confirm real customer usefulness, rollout/rollback and operational cost before enabling each addition.

## Deferred / conditional ideas

These remain open for demand assessment and do not block the core roadmap.

- [ ] D-01 — Adaptive testing, after the core engine and assessment evidence justify it.
- [ ] D-02 — Automated interviews, after customers establish a need and review rules.
- [ ] D-03 — Automated resume ranking, after customers establish a need and review rules.
- [ ] D-04 — Extensive AI-generated question libraries, after reliable human review and version control exist.
- [ ] D-05 — Earlier question-drafting assistance only with human review and content versioning.
- [ ] D-06 — Billing and advanced tenant management when needed for the business model.
- [ ] D-07 — Evaluate additional vendor-reference capabilities only when selected for a real product need.

## Progress history

| Date | Section | Change / evidence | Next action |
| --- | --- | --- | --- |
| 19 November 2026 | Baseline | Existing capabilities inventoried from the source review; broad journey/load acceptance remains open | Preserve baseline while completing exam safety |
| 19 November 2026 | 1A | Candidate-bound access, legacy bypass closure, authenticated telemetry, limits, desktop renewal and client compatibility implemented; focused unit/integration/client checks and build passed | Complete the linked manual review; user acceptance pending |
| 19 November 2026 | Tracker | Full feature checklist and ongoing update rules added | Update this file alongside each future section and review checkpoint |
| 19 November 2026 | 1A review execution | Repeated tests/build passed; isolated API/broker setup and 36 live checks passed; native verification screen opened and initial layout inspected | Collect user sign-in/keyboard/zoom observations and elapsed 16-minute walkthrough; acceptance pending |
| 19 November 2026 | 1A review correction | Reproduced user's illegal `fetch` invocation in Electron; corrected shared default transport; eight credential tests, six native renderer checks and desktop build passed | Repeat user sign-in walkthrough; keep 1A acceptance and 1B pending |
| 19 November 2026 | 1A sign-in review | User confirmed corrected sign-in and expected schedule/paper pattern; moved passcode entry to verification screen to allow retries; type checks/build passed | Review candidate-details/honor-code/hardware/code flow; leave full section acceptance pending |
| 19 November 2026 | 1A requested UI addition | Shared eye reveal/hide control added to desktop passwords, passcodes and invitation tokens; keyboard/accessibility and reduced-motion behavior included; type checks/build passed | Review reveal/hide behavior and eye transition, then continue the 1A walkthrough |
| 19 November 2026 | 1A password eye review | User confirmed password show/hide, open/closed-eye transition and keyboard operation work as expected | Review candidate-details/hardware/passcode flow and remaining sensitive-field behavior; full section acceptance pending |
| 19 November 2026 | 1A pre-exam review | User confirmed details/terms/hardware/code-retry/outline and passcode-eye flow; database shows persisted unlock and no start timestamp | Review exam entry, paper loading and timer, then elapsed renewal/submission; acceptance pending |
| 19 November 2026 | 1A exam execution review | User confirmed fullscreen/paper/timer/navigation and submitted; logs show 200/200/202, database SUBMITTED with two answers; console 401/403 traced to negative login/unlock tests | Run a separate 16-minute native renderer renewal check; remaining review/acceptance pending |
| 19 November 2026 | 1A legacy review | User confirmed legacy invitation sign-in, code rejection/editing and valid-code outline access | Complete elapsed renewal and remaining visibility/zoom checks; section acceptance pending |
| 19 November 2026 | Review pause | User confirmed invitation/password remasking and Tab/200% zoom, then requested a pause; renewal run stopped after 510 seconds/18 successful checks before token expiry | Wait for the user's continue instruction; restart elapsed renewal in a fresh attempt, then finish review before 1B |
| 19 November 2026 | Review resumed | User said continue; restarted native elapsed renewal with a fresh synthetic attempt; five groups/seven scenarios remain and estimates supplied; original 1.0.0 build located in lockdown-client/dist | Finish tests and record results; explicit 1A acceptance still required before 1B |
| 19 November 2026 | Resumed command checks | Six scenarios pass: natural 960-second renewal/33 checks/three credentials/two saved answers; three wrong accounts; Candidate Login without second sign-in; duplicate-submit/loading. Real gateway fallback and simulated old-version warning pass. Archived 1.0.0 has no probe, so actual detection remains incomplete | Review new UI observations and resolve or explicitly waive the actual old-client scenario; full 1A acceptance still pending |
| 19 November 2026 | Requested visual refinement | User requested matching gateway styling and a table/dashboard schedule. Added a responsive schedule dashboard and reusable paper metrics/table, applied light gateway styling, corrected CSS Module loading and desktop shell spacing | Finish build/visual checks and collect fresh UI review; 1A acceptance and actual old-client detection remain pending |
| 19 November 2026 | Visual refinement verification | Desktop/portal production builds and type checks passed; native screenshots verify matching light gateway styling, dashboard table, narrow stacking and 200% reachable actions. Refreshed previews open for review | Obtain 1A-R5 visual acceptance; actual old-client scenario and full 1A acceptance remain open |
| 19 November 2026 | Visual refinement accepted | User replied “Both look correct” to the refreshed gateway theme and schedule dashboard/table review; 1A-R5 checked for that visual scope | Remaining account-entry/error/loading observations, actual old-client detection and full 1A acceptance remain pending; do not start 1B |
| 19 November 2026 | Progression authorized | User explicitly said to continue remaining work and the next section, then confirmed error/loading screenshots are clear. 1B starts on verified candidate-bound access; actual archived-client detection remains unchecked | Build/test shared durable autosave and recovery; stop at the 1B review gate |
| 19 November 2026 | 1B complete for review | Shared lifecycle/checkpoints, durable clears/flags/navigation, encrypted journal/replay, explicit resume/conflicts and 1.2.0 compatibility implemented. Real DB/Redis checks, 17 client tests, eight DPAPI checks, both built-UI restart/submission flows and builds passed; review gallery and five visual checks provided | Stop before 1C; collect 1B visual acceptance; target rollout and earlier archived-client detection remain open |
| 19 November 2026 | 1B review accepted | User replied “All five look correct” to saved status, saving/offline/error, recovery/timer, conflict choices and narrow/200% gallery checks; 1B-V1–V5 and 1B-R1 checked. Existing command evidence and deployment status remain separate | 1C is the next pending section; await continuation at the completed review boundary. Deployment and earlier 1A observations remain open |
| 19 November 2026 | 1C authorized | User said “ok next section” and explicitly deferred deployment until the remaining sections are built | Implement/test delivery, deadlines and receipts in isolation; stop for 1C review; do not deploy |
| 19 November 2026 | 1C complete for review | Atomic frozen submissions/outbox, confirmed publisher retry/reconnect, original content/policy grading, disconnected zero-grace deadlines and stable receipt UI implemented. Both-model DB/grading tests, 26 service tests, six live delivery groups, nine desktop groups, focused scrolled/200% checks, three gateway scenarios and builds pass. Review grader manually restarted after outage; 1D recovery remains pending | Stop before 1D; collect 1C-V1–V6 and 1C-R1 acceptance using the linked checkpoint/gallery. Deployment remains deferred |
| 19 November 2026 | 1C completion correction | User requested no candidate grading wait/status, one-minute close and confidential recruitment results. Added native close timer and immediate Exit; candidate receipt/listing APIs and portal omit grades/status. Evaluator publication/optional result email remain 3F | Verify amended screens and privacy; do not infer acceptance from the change request or deploy |
| 19 November 2026 | 1C correction verified | 29 service tests, both-adapter DB/grading tests, six live delivery groups, nine desktop groups, real native closes at 60.007/60.014 seconds, candidate privacy checks and builds pass. Updated gallery/checkpoint includes the countdown and private submission records | Stop for revised 1C visual acceptance; 1D and deployment remain pending |
| 19 November 2026 | 1C accepted / 1D authorized | User replied “Yes thats good now next section” to the revised six-group review; 1C-V1–V6 and 1C-R1 accepted | Build and test 1D worker retry, dead-letter, reconnect and health infrastructure; stop for review; do not deploy |
| 19 November 2026 | 1D source checks | Shared runtime/ledger, bounded quorum retries/DLQ, atomic completion, cancellable SMTP, reconnect and private health code implemented. Four runtime and two SMTP tests, disposable API/grader tests, migration reruns and 29 client tests pass | Docker image build lost engine connectivity; live topology/reconnect/eight scenario checks remain open. Finish runtime verification before requesting 1D acceptance |
| 19 November 2026 | 1D complete for review | Engine recovered; setup resumes review dependencies and preserves health ports. Five runtime/two SMTP tests, full DB/grading/client suite, final builds, eight real broker/worker groups and keyboard/narrow/200% readout checks pass. Queue metadata lag is explicit Unknown; worker processes reconnect without restart | Stop before Batch 2; review 1D-V1–V4 and 1D-R1. Target deployment, earlier 1A observations and operator replay/alert integrations remain open |
| 20 November 2026 | 1D accepted | User replied “Yes” to all four worker readout review groups; 1D-V1–V4 and 1D-R1 checked. Automated evidence and deployment remain separate | Await continuation; 2A is the next planned section. Combined Batch 1 review and earlier 1A observations remain open; deployment stays deferred |
