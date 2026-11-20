# Review checkpoint: 1A — candidate-bound attempt access

Current checkpoint: [section 1B](implementation-review-1b-2026-11-19.md). The user authorized progression after the reviews recorded here; this document retains the earlier 1A test history.

Implemented on 19 November 2026. Paused at the user's request; resume remaining
tests only when the user says **continue**. Section 1B has not started.

Ongoing feature status and future review gates: [feature checklist](feature-checklist.md).

Source roadmap: [assessment-platform-review-2026-11-19.md](C:/Users/sobha/.codex/visualizations/2026/11/18/01a1f096-54c8-74d2-a920-2cdde2296904/assessment-platform-review-2026-11-19.md).

## Scope and dependency order

The roadmap's first batch is exam safety. This checkpoint completes its access
control section, which the answer-saving endpoints must depend on. It does not
complete Batch 1's full release gate.

| Section | Status | Dependency / review boundary |
| --- | --- | --- |
| 1A: attempt authorization, legacy start bypass closure, authenticated telemetry, access rate limits | Implemented; awaiting review | Shared identity and unlock policy for both execution models |
| 1B: durable autosave, protected local recovery, versioned updates, cleared/unanswered answers, save acknowledgement UI | Next after review | Every answer read/write must use 1A's attempt access layer |
| 1C: transactional outbox and confirmed delivery; deadline finalization and stable receipts | Pending | Finalization must use 1B's persisted snapshot and atomically save its delivery job |
| 1D: bounded worker retries, dead-letter handling and reconnect recovery | Pending | Exercise outbox delivery, broker outages and redelivery before completing Batch 1 |
| Batch 2 and later | Pending | Follow the original roadmap after the complete exam-safety gate passes |

## What changed

- Invitation links locate the assessment. Candidates must authenticate with the
  account assigned to the invitation before receiving execution access.
- `POST /api/exam/access` exchanges the candidate account JWT and invitation token
  for a 15-minute attempt token. It binds candidate, organization, event/blueprint,
  session/invitation, execution model and allowed operations.
- Check-in tokens permit unlock only. Correct passcodes persist `unlocked_at` and
  return a token permitting start, questions, submission and telemetry. The API
  checks current database ownership, registration, role and status on every request.
- Event and legacy route adapters use one access service and repository interface.
  Legacy start no longer works with an invitation, account JWT, session UUID, or
  caller-supplied candidate ID alone.
- Telemetry derives its event and candidate identity from the attempt. Conflicting
  supplied identifiers are rejected, and the reporter is assigned by the server.
- Redis applies atomic rate limits: 10 logins per account per minute, 1,000 per IP
  per minute, 60 access exchanges per candidate per minute, 10 unlocks per attempt
  per minute and 120 incidents per attempt per minute. Denials return HTTP 429 and
  `Retry-After`. Redis failures return HTTP 503 for these access checks.
- Bounded request bodies cover login/access (4 KiB), telemetry (16 KiB) and exam
  routes (1 MiB), including requests without a declared content length. Forwarded
  IP headers are not trusted by default.
- The desktop uses one in-memory credential client for exam requests and native
  telemetry, and one reusable candidate sign-in form. Renewal is shared across
  concurrent requests and checked every 30 seconds while the attempt is open.
  Stale responses cannot restore signed-out credentials or downgrade an unlocked
  token. Only a rejected authentication request is automatically retried once.
- Client source version is 1.1.0. Both invitation models advertise at least 1.1.0,
  preserving a blueprint's higher minimum version. No installer was published.

## Compatibility and rollout

Run migration 10 before the updated API. Local startup includes it automatically.
The migration preserves previously verified event sessions on its first application;
repeating it does not restore an explicitly revoked unlock. Existing legacy
instances must verify their passcode again because their old start route allowed a
bypass. Legacy assessments must have an organization owner; unscoped blueprints
cannot receive a candidate-bound token.

Use the updated desktop source/build to review. A previously installed 1.0.0 client
cannot execute against the updated API. Publish a working 1.1.0 installer/download
and its release record together before a production rollout. This work has not
restarted the running local platform or deployed to production.

## Automated verification

From the repository root, with Docker Desktop running and Go/Node available:

```powershell
.\scripts\test-attempt-access.ps1
```

The script creates disposable PostgreSQL and Redis containers on random loopback
ports, applies the actual bootstrap and migrations, creates an isolated test
database, runs API tests, desktop credential tests and desktop type checks, then
removes the test containers. It does not use the running platform database or send
email/grading jobs.

Verified passing:

- API unit tests: missing/account/invitation credentials, scope and path mismatch,
  candidate and organization mismatch, live role/registration/unlock changes,
  terminal attempts, signature/algorithm/audience/issuer checks, exact token expiry,
  portal/attempt token separation, spoofed telemetry, legacy identity tampering,
  dependency failure, HTTP 429 and bounded/chunked payloads.
- Real PostgreSQL/Redis integration: candidate login and exchange, invalid and valid
  codes, persisted unlock, start-before-unlock rejection, stable repeated start
  times, question access, cross-candidate routes, telemetry association, token
  renewal, role changes, expired status, old legacy instance bypass rejection,
  all three proctoring modes, hardware policy and concurrent rate limiting.
- All eight desktop credential tests, desktop TypeScript checks and `npm run build`.
- Minimum client version comparisons, including higher versions such as 1.10.0.

## Live review execution — 19 November 2026

The command suite and desktop build were rerun successfully. The isolated review
API runs with the application database role and the actual API image. Its gateway
for this run is `http://127.0.0.1:50201`; the existing platform on port 13000 was
left running. Review environment identifier: `6993480425c7`.

`scripts/check-attempt-review.ps1` passed **36 live checks** against that gateway:
missing credentials, wrong password, other candidate/organization/staff exchange,
account-token separation, unlock policy, event/legacy minimum version, repeated
start timestamps, paper access, telemetry ownership and a filled submission
accepted with HTTP 202 while RabbitMQ was available. The legacy start bypass was
rejected, then start succeeded after verification.

The actual desktop credential client also renewed and retried successfully after
the live API rejected an injected expired token. This was deterministic expiry
testing; **the elapsed 16-minute desktop walkthrough remains pending**.

Machine-readable evidence is saved in
`.attempt-access-review/6993480425c7/command-results.json`. The desktop was launched
and inspected through its native window: the correct invited email, password field,
primary action and alternate-invitation control are visible at the current size.
The development tools panel was closed to show the full form. The user subsequently
confirmed corrected sign-in reaches the schedule screen with the expected paper
pattern and candidate-details button. Keyboard/200% zoom and the remaining
walkthrough are pending. These observations do not constitute section acceptance.

The first review startup failed because an early root broker diagnostic created
an Erlang cookie with incorrect ownership. Readiness diagnostics now run as the
RabbitMQ user and include failure logs. The broker was restarted successfully and
the live submission check subsequently passed.

### Review correction — native browser fetch

The user reported `Failed to execute 'fetch' on 'Window': Illegal invocation` during
the sign-in walkthrough. This was reproduced in Electron: storing native `fetch`
directly as a class property made calls use the `AttemptClient` instance as the
receiver. Earlier Node/injected-transport checks did not expose Chromium's receiver
requirement. The default shared transport now calls `globalThis.fetch(input, init)`.

A regression test failed before the fix and all eight credential tests passed
afterward. Six checks using the real Electron/Chromium renderer also passed:
wrong-password API error, assigned-candidate sign-in, assigned exam listing,
invitation exchange, forced renewal and a scoped question request rejected before
unlock. The type checks and desktop build passed again. Evidence is saved in
`.attempt-access-review/6993480425c7/renderer-results.json`. The live-check script now
includes these renderer checks for future runs (42 checks in a fresh environment).
The 36-check report above records the original API run; the separate six-check
renderer report records this correction. The user confirmed the corrected sign-in
retest reaches the expected schedule screen. 1A acceptance and the actual
16-minute/keyboard/zoom review remain pending.

### Next review — candidate details and passcode retry

The user's requested visibility control is shared by the desktop candidate-password,
invigilator-passcode and invitation-token fields. Each field starts masked; its
button animates between closed/open eye states, uses Show/Hide accessible labels,
supports keyboard activation and respects reduced-motion preferences. Clearing or
disabling the field resets it to masked. The button never submits a form. Type
checks and the desktop build passed. The updated client was opened and its native
window shows the eye beside Password with an accessible Show password toggle.
The user confirmed the password show/hide behavior, eye animation and keyboard
toggle work as expected, then the passcode eye, invitation/password remasking and
Tab/200% zoom readability/reachability. These approvals do not accept the entire
1A section; remaining tests were paused at the user's request.

The candidate password eye check is complete. Continue signing in with the assigned
account/password from the fixture table below if needed. At the tutorial, repeat
the eye check on the passcode. Check that clearing a revealed field or submitting
the password masks it again. Invitation entry uses the same control.

The passcode input was moved from the honor-code screen to the tutorial screen,
next to its verification action. A rejected code can now be edited and retried
without restarting the check-in flow; editing clears its previous error, and the
input is disabled while verification runs. Type checks and the desktop build
passed. The user confirmed candidate details, honor code, hardware checks, wrong-code
editing, valid-code access and reaching **Engage lockdown & start exam**. A database
check confirmed `unlocked_at` is persisted and `started_at` remains NULL. The stored
status is IN_PROGRESS after unlock, but the 60-minute duration timer is still unstarted.

1. Sign in again if the desktop was closed. Select **Continue to candidate details**.
   Try continuing with a required field blank: expect a readable validation error.
   Complete the required sample details and continue to the honor code.
2. Accept the terms and run hardware checks. For this OFFLINE_NORMAL fixture, expect
   **Single display verified** and **Camera and microphone: Not required for this
   proctoring mode**. Continue to the tutorial.
3. Enter `000000`, then select **Verify passcode & review questions**. Expect a code
   error, remain on the tutorial and be able to edit the code.
4. Replace it with `123456` and verify. Expect the assessment outline. The top window
   countdown is the entry window; the exam-duration timer has not started.
5. Stop at the outline for this observation. Report the error/retry behavior and
   whether buttons and inputs remain clear and usable. Exam entry, elapsed renewal,
   legacy and keyboard/zoom checks follow separately.

### Next review — exam entry and timer

The pre-exam walkthrough above has been confirmed by the user. The user also
confirmed fullscreen exam entry, both questions and timer/navigation, then submitted
to leave lockdown and report back. The entry steps were:

1. Select **Engage lockdown & start exam**. Expect fullscreen/kiosk mode, a question
   overview with the two sample questions (MCQ and fill-in-the-blank), and an
   exam-duration countdown near 60 minutes.
2. Open both questions and return to the overview. The countdown must continue
   rather than reset; the header's entry-window countdown is separate.
3. Report whether paper loading, fullscreen entry and timer/navigation behave
   correctly. Keep the test window open and do not submit yet; elapsed credential
   renewal and submission are the next observation. Server start/deadline checks
   will use the persisted start time once the user enters.

### Exam execution evidence and console errors

The API logs and database confirm the actual candidate A run:

| Time (Asia/Calcutta, 19 November 2026) | Request / result |
| --- | --- |
| 13:18:41 | Wrong-password login returned 401; subsequent correct login returned 200 |
| 13:21:48 | Wrong-passcode unlock returned 403; subsequent valid unlock returned 200 |
| 13:24:42 | Exam start returned 200 |
| 13:24:43 | Questions returned 200 |
| 13:26:26 | Submission returned 202 |

There were no 401/403 responses between exam start and submission. Candidate A is
SUBMITTED and both answers are persisted. The console retained the intentional
negative-test requests; they do not indicate failed exam execution. Raw evidence:
`.attempt-access-review/6993480425c7/api-user-review.log`.

The attempt lasted about 1 minute 43 seconds, so it did not establish elapsed
15-minute credential renewal. A separate synthetic candidate/session is being
exercised by `.\scripts\check-attempt-review-renewal.ps1`. It uses native Chromium
fetch and the real AttemptClient, checks authorized question access every 30 seconds
for 16 elapsed minutes, verifies natural renewal/paper/timer preservation and submits
both responses. It opens no visible lockdown window and preserves the user's
submitted attempt. Results will be saved in `renewal-results.json` with submission
state/answer-count verification. The user asked to pause before this run completed.
It was intentionally stopped after 510 seconds and 18 successful paper checks,
before the original credential expiry. No elapsed-renewal pass is claimed; the
nonzero runner exit reflects intentional termination. Progress is saved as
`paused_by_user` in `renewal-progress.json`. Resume with a fresh sample attempt
using the same command only after the user says **continue**.

The user subsequently confirmed the legacy invitation sign-in, editable wrong-code
error and `654321` verification leading to its outline. Legacy execution authorization
and bypass rejection were already covered by the command suite. This completes the
legacy pre-exam UI observation; the user was asked to stop before lockdown.

## Resumed review results and remaining checks

The user said **continue** on 19 November 2026. Six of the seven remaining
scenarios are now command-verified. Section acceptance and the new user visual
observations remain separate and unchecked in the feature tracker.

| Group | Command result | Remaining review / estimate |
| --- | --- | --- |
| Elapsed renewal and filled submission | PASS: 960.15 seconds, 33 authorized paper checks, three credentials, unchanged question order/start/deadline, HTTP 202, PostgreSQL SUBMITTED with two answers | Complete; no additional waiting |
| Wrong accounts: other candidate, foreign organization, staff | PASS in the built React desktop UI against the isolated API; each stays on account verification with a clear error and empty password | Visual error review: 1–2 minutes |
| Candidate Login without invitation paste | PASS: assigned exam listing → schedule using exactly one account login; no second password form | Visual listing/schedule review: 1–2 minutes |
| Loading and repeated submit | PASS with a held real login request: password/submit disabled, visible verifying label, five extra submit events generate no extra requests, releasing the request restores controls and clears password after the error | Visual loading review: about 1 minute |
| Actual 1.0.0 update prompt | INCOMPLETE: archived app has no version-probe server. Real gateway fallback and simulated 1.0.0 update warning both pass | Simulated warning review: about 1 minute; actual compatibility retest depends on resolving legacy detection |

Evidence in `.attempt-access-review/6993480425c7/`:
`renewal-results.json`, `ui-results.json`, `gateway-results.json` and their logs.
The previous interrupted renewal run remains recorded as incomplete historical
evidence; the fresh successful run uses a different synthetic candidate/session.
The existing platform and the user's submitted candidate A attempt are preserved.

The available `lockdown-client/dist/win-unpacked/resources/app.asar` reports 1.0.0.
Its archived main process starts kiosk mode immediately and contains no HTTP
version probe. It was inspected without launching that kiosk. This build cannot
produce the gateway's detected-old-version branch. The gateway checks use an
explicitly simulated unavailable/1.0.0 probe response, alongside the real invitation
API and real portal UI. They do not establish actual installer detection. A working
1.1.0 installer/download is still a rollout requirement. The preview's update link
is a review fixture; do not treat it as a published installer or use it to install.

The gateway preview is open at the simulated update warning. Check that
**Detected (v1.0.0)**, **Minimum required v1.1.0**, the update warning and update
button are readable, and that no **Launch Lockdown Client** action appears.
Command-captured desktop screenshots are available for visual review:

- [Wrong-account error](../.attempt-access-review/6993480425c7/ui-wrong-account.png): readable candidate-account error, empty password, retry controls.
- [Loading state](../.attempt-access-review/6993480425c7/ui-login-loading.png): visible verifying label and disabled submit/password; command check verifies duplicate suppression and recovery.
- [Assigned assessments](../.attempt-access-review/6993480425c7/ui-assigned-assessments.png): clear exam/status and Review exam action.
- [Account-entry schedule](../.attempt-access-review/6993480425c7/ui-account-schedule.png): expected exam/candidate/paper pattern and candidate-details button, with no second login.
- [Simulated update warning](../.attempt-access-review/6993480425c7/gateway-old-version-simulation.png): detected/minimum versions and warning; actual old-client detection remains incomplete.
- [Unavailable probe fallback](../.attempt-access-review/6993480425c7/gateway-no-probe.png): Not detected and manual launch fallback.

To repeat the built UI commands using the retained `ui-fixtures.json`:

```powershell
.\lockdown-client\node_modules\electron\dist\electron.exe .\scripts\check-attempt-review-ui.cjs
.\lockdown-client\node_modules\electron\dist\electron.exe .\scripts\check-attempt-review-gateway.cjs
```

To review Candidate Login interactively, run
`.\scripts\open-attempt-review-client.ps1 -EntryScreen`, select **Candidate Login**,
and sign in as `ui-review@attempt-access.test` with `TestPassword123!`.
Select its assigned exam and stop at the schedule before entering lockdown.
This fresh sample account is separate from submitted candidate A.

Stop at 1A for review. Do not infer full acceptance from individual observations
or progress questions. Actual old-client detection must be resolved or explicitly
waived before treating that scenario as complete; 1B still awaits section acceptance.

### Requested visual refinements — 19 November 2026

The user requested consistent gateway styling and a clearer schedule dashboard.
The gateway now matches the desktop's light background, white cards, indigo
actions, green candidate branding and typography. Amber highlights the update
message. A scoped CSS Module keeps these styles within the gateway; the existing
Tailwind loader now excludes CSS Modules so class exports are preserved.

The schedule dashboard has summary cards for sections, questions, marks and
duration, separate candidate/entry-window panels, and a table of question formats,
counts and marks by section with a paper total. Paper metrics and the table are
shared with the exam outline. Unknown paper data displays an unavailable message
rather than fabricated totals. The existing server window and authorization rules
still control access. Removed desktop demo-root spacing and made the header wrap
so zoomed layouts remain reachable.

Desktop and portal production builds/type checks passed. Native checks passed
for authentication errors, loading, account entry, question formats/counts,
narrow layout and 200% action reachability. Gateway checks additionally verify
that theme styles are actually applied, update requirements hide Launch, and
the unavailable-probe fallback works. Final evidence remains in `ui-results.json`
and `gateway-results.json` with refreshed screenshots.

The Next.js build reported an existing framework security advisory and recommends
upgrading Next.js. No framework upgrade or production deployment was included in
this UI refinement. Actual archived 1.0.0 detection is still incomplete.

Both refreshed preview windows are open. This visual review should take 3–5 minutes:

1. [Schedule dashboard](../.attempt-access-review/6993480425c7/ui-account-schedule.png):
   check 1 section, 2 questions, 2 marks and 60 minutes for the sample. The paper
   table must show one fill-in-the-blank and one multiple-choice question, each
   worth 1 mark, with a total of 2 questions/2 marks. Check candidate/email,
   entry-window times and spacing. Scroll down to the continue button.
2. [Matching gateway](../.attempt-access-review/6993480425c7/gateway-old-version-simulation.png):
   check the light background/card styling matches the desktop. Scroll to see
   the amber update message and indigo button. It must show detected 1.0.0,
   required 1.1.0 and no Launch action. The download remains a fixture.
3. Check the [narrow schedule](../.attempt-access-review/6993480425c7/ui-account-schedule-narrow.png)
   and [narrow gateway](../.attempt-access-review/6993480425c7/gateway-old-version-narrow.png):
   cards should stack and text should wrap. The schedule table scrolls inside
   its own region, with a keyboard focus outline.
4. Check [schedule action at 200%](../.attempt-access-review/6993480425c7/ui-account-schedule-200-percent-action.png)
   and [gateway action at 200%](../.attempt-access-review/6993480425c7/gateway-old-version-200-percent-action.png):
   scrolling must bring the primary action fully into view. Report clipping,
   unclear hierarchy or spacing that needs adjustment.

To reopen the current-source gateway preview without rebuilding the isolated
container, build `admin-portal`, run `scripts/open-attempt-review-portal.ps1`, then
pass the resulting loopback URL as `--portal-url` to
`scripts/check-attempt-review-gateway.cjs` using Electron. The helper saves its
server PID/URL in `portal-preview.json`. Close this local preview server before
rebuilding on Windows. The gateway harness routes API reads to the isolated API
and explicitly simulates the version probe. Future full review setups build the
current portal image instead of reusing the older local image.

The user replied **“Both look correct”** to the gateway-theme and schedule
dashboard/table review on 19 November 2026. That visual refinement is accepted
and 1A-R5 is checked. Narrow/200% layouts and continue behavior remain recorded as
command verification; this response does not establish additional manual tests.
The user subsequently confirmed the wrong-account/loading screenshots are clear
and explicitly authorized continuing the remaining work and the next section.
1B was implemented under that authorization. Candidate Login listing visual review
and actual archived-client detection remain open. Continue review at the
[1B checkpoint](implementation-review-1b-2026-11-19.md); stop before 1C.

## Manual review steps and expected results

1. Use the isolated review environment so the running platform data is preserved.
   From the repository root, these commands run the tests, retain sample candidates,
   build/start the API and gateway, check live requests, build and open the desktop:

   ```powershell
   .\scripts\start-attempt-review.ps1
   .\scripts\check-attempt-review.ps1
   Push-Location .\lockdown-client
   npm run build
   Pop-Location
   .\scripts\open-attempt-review-client.ps1
   ```

2. The retained fixtures include an **OFFLINE_NORMAL** event, MCQ and fill-in-the-blank
   questions, a 60-minute duration, a four-hour entry window and a legacy invitation.
   The live command checks start and submit candidate B; candidate A stays fresh for
   visual review. Run the live checks once per fresh environment. Synthetic accounts:

   | Account | Email |
   | --- | --- |
   | A: assigned candidate | `assigned@attempt-access.test` |
   | B: other candidate | `other@attempt-access.test` |
   | C: other organization | `foreign@attempt-access.test` |
   | Staff | `proctor@attempt-access.test` |

   All use password `TestPassword123!`. Event code: `123456`; legacy code: `654321`.
   The launch command loads `test-event-invitation`. For the legacy walkthrough,
   return to link entry and enter `test-legacy-invitation`. The gateway URL, fixture
   identifiers, logs and command report are under the directory recorded in
   `.attempt-access-review/latest.json`. Those generated files are ignored by Git.

3. Load A's invitation in the updated desktop. Expect the account verification
   screen with A's email. Try an incorrect password, then B's account, then C's
   account, then a staff account. None should reach the exam. Errors should remain
   readable; the password should clear after each sign-in attempt.

4. Sign in as A. Expect the schedule screen, then candidate details, honor code,
   diagnostics and tutorial. Enter a wrong access code on the tutorial: the outline/exam must remain
   inaccessible and the exam timer must not start. Enter the valid code: the outline
   opens. The timer starts only when you choose to enter the exam.

5. Repeat from **Candidate Login** without initially pasting a link: sign in as A,
   select the assigned exam and continue. Expect the same verification and unlock
   rules without a second unnecessary account sign-in.

6. Keep a test attempt open for at least 16 minutes. Continue answering and submit
   before its deadline. Expect no interruption when the first 15-minute access token
   expires. For this checkpoint, use nonempty responses and avoid the known cleared
   answer/deadline paths that belong to 1B/1C.

7. Check keyboard operation with Tab/Shift+Tab and Enter: email, password, submit and
   back controls must be reachable, visibly focused and labelled. Check the sign-in
   screen at the supported desktop width and 200% zoom for readable errors, a visible
   primary action and usable scrolling. Confirm loading buttons prevent duplicate
   sign-in submissions.

8. Open an existing organization-owned legacy blueprint invitation. Repeat the
   account and code checks; it must start only after verification. An older instance
   alone must not authorize start. The isolated integration test covers the API
   bypass and cross-identity requests directly if no legacy fixture is available.

9. Check the gateway's advertised minimum client version. An installed 1.0.0 client
   must be prompted to update to at least 1.1.0; a blueprint requiring a higher
   version must retain that requirement. Download/installer publishing is still an
   operational step, and the production loopback-probe issue remains in Batch 2.

Close the desktop after review, then run `.\scripts\stop-attempt-review.ps1` to
remove only the generated review containers/network. Reports and fixtures remain
saved. A fresh setup generates a new invitation window and resets the sample state.

Do not treat this checkpoint as crash recovery, durable autosave, deadline-safe
submission, stable receipt delivery, broker recovery, live remote proctoring or a
500-candidate capacity validation. Those gates remain in the roadmap.
