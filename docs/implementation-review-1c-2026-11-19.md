# Section 1C — submission, deadlines and receipt review

19 November 2026. Implementation, command verification and user visual acceptance
complete. The user replied “Yes thats good now next section” to the revised
six-group review and authorized 1D. Deployment and
installer/release publication remain deferred by the user's explicit instruction.

## What changed

Event and legacy attempts share immutable paper/scoring snapshots, atomic
submission/outbox transactions, idempotent finalization and authorized stable
receipts. A disconnected deadline freezes the last server-accepted answers.
The API can start and accept durable submissions while RabbitMQ is unavailable;
the outbox reconnects and retries confirmed publication. Repeated/concurrent
grading leaves one effective result for the submission/version.

The desktop distinguishes pending confirmation from a received submission,
retains encrypted recovery while confirmation is unknown, and supports retry,
receipt ID selection and receipt reopen after sign-in. The user's review correction
removes grading status/refresh entirely: the candidate receives submission
confirmation, an immediate Exit action and a native **60-second automatic close**.
Scores and internal grading state are also omitted from candidate receipt/listing
APIs and the portal. Evaluator-confirmed publication and optional result email
delivery remain 3F; recruitment results stay confidential by default. Native
kiosk release requires a server-verified receipt. Completion stops camera/mic
processing. The gateway offers receipt entry for submitted invitations. Source
and minimum client compatibility are 1.3.0, retaining higher requirements.

The [submission and delivery contract](attempt-submission-contract.md) defines
responsibilities, authorization, exact zero-grace deadline policy, recovery
limitations and the worker-only answer vault. Migration 12 and future deployment
requirements are documented in [DEPLOYMENT.md](../DEPLOYMENT.md).

## Command checks completed

- Disposable PostgreSQL/Redis API tests passed for both adapters: submission and
  outbox rollback together, stale/duplicate finalization, stable receipt access
  after completion, deadline rejection after parent-lock waiting, disconnected
  unanswered finalization, publisher retry and publication followed by failed
  database acknowledgment. Historical saved grades survive receipt recovery
  without another job or a changed evaluation timestamp.
- Lifecycle checks passed immediately before, exactly at and after the deadline.
  Server time governs eligibility; a backdated client timestamp cannot admit a
  late edit. Migration 12 reruns successfully.
- Frozen grading checks passed for both models: original content/marks/options/
  keys after authoring changes, current MCQ/FIB policy, eight concurrent grading
  deliveries, repeated delivery without result timestamp changes, old-message
  resolution, wrong-version rejection and API denial of vault-key reads.
- All **29 desktop service tests** passed: eight credential, nine checkpoint,
  six submission-controller, three native receipt-verification and three native
  close-timer tests. The timer closes at one minute without renderer activity,
  duplicate completion cannot extend it, and changing attempts cancels it. Unknown
  or malformed confirmation cannot delete recovery or release native controls.
- Desktop type checks and final production build passed. Isolated API/grader
  images were rebuilt. The portal production build passed earlier in this
  section; its tooling reported a Next.js security advisory, which remains a
  dependency follow-up before release. This review does not resolve that advisory.
- **Six live delivery groups** passed against the isolated API/PostgreSQL/broker:
  saved-revision deduplication; receipt/outbox persistence during broker outage;
  six concurrent retries sharing one receipt; API restart while broker is down;
  disconnected legacy deadline and late-edit rejection; confirmed publisher
  reconnect, frozen grading and an unchanged candidate receipt without private
  grading fields. The candidate listing also omits confidential scores/timestamps.
- **Nine built-desktop groups** passed: five event and four legacy, including a
  deliberately lost committed response, retained unknown recovery, retry to the
  same receipt without waiting for grading, full receipt ID selection/focus, encrypted
  journal deletion, reload/sign-in to the same receipt and a real one-minute
  legacy deadline with an unsent draft. The deadline input is disabled.
- Focused reopen checks verified the scrolled Exit control is inside the main
  viewport at narrow width/200% zoom for both models. Top and scrolled screenshots
  show both ends of the receipt. Three completed-gateway scenarios passed:
  submitted receipt entry and simulated old/matching version requirements.
- Both real-clock completion runs closed the application at approximately
  **60.007 seconds (event)** and **60.014 seconds (legacy)**, using the native
  timer and live server receipt proof. The confirmation screen is available
  immediately and does not wait for grading. Candidate API and built-portal
  privacy checks passed; submitted records contain no confidential scores or
  evaluation status. These are two additional close runs and two portal/API
  privacy checks alongside the nine desktop groups.

Desktop tests use the built renderer, real native encrypted vault and live API.
Hardware/kiosk enforcement IPC are test doubles, so they do not claim another
human OS-lockdown walkthrough. Receipt proof rules are tested separately in
native service tests. Transport failures and version probe responses are
deliberately injected; accepted saves, finalization and grading use real services.

The delivery harness **manually restarts the review grader** after broker
recovery. Automatic worker consumer reconnect/retries remain 1D; the successful
1C publisher-reconnect check does not establish them.

Evidence in the ignored isolated review directory:

- [Live delivery results](../.attempt-access-review/6993480425c7/submission-delivery-results.json)
- [Event UI results](../.attempt-access-review/6993480425c7/submission-event-ui-results.json)
- [Legacy UI results](../.attempt-access-review/6993480425c7/submission-legacy-ui-results.json)
- [Gateway results](../.attempt-access-review/6993480425c7/submission-gateway-results.json)
- [Event zoom log](../.attempt-access-review/6993480425c7/submission-event-zoom.stdout.log)
- [Legacy zoom log](../.attempt-access-review/6993480425c7/submission-legacy-zoom.stdout.log)
- [Event automatic close](../.attempt-access-review/6993480425c7/submission-event-auto-close-results.json)
- [Legacy automatic close](../.attempt-access-review/6993480425c7/submission-legacy-auto-close-results.json)
- [Candidate privacy checks](../.attempt-access-review/6993480425c7/submission-candidate-privacy-results.json)

The active API is `http://127.0.0.1:50201`; the original platform was preserved.
The current synthetic invitations have been submitted. Create fresh fixtures
before repeating a complete attempt.

## Six visual review groups — accepted

Open the [revised 1C review gallery](http://127.0.0.1:65479/submission-review.html).
Select each numbered navigation link, then scroll through its screenshots or
open them full size. These are screenshot observations; the command behavior
above has already been tested. No exam entry or kiosk is required. Total estimate:
**12–18 minutes**.

| Check | What to review | Expected appearance | Estimate |
| --- | --- | --- | --- |
| 1C-V1 | Unknown submission confirmation | Retained-answer message and Retry confirmation are readable; the answer remains visible and the screen does not claim success | 2–3 min |
| 1C-V2 | Receipt and automatic close | Responses received, submission time, ID, 01:00 countdown and immediate Exit are clear; there is no grading status, score or refresh action | 2–3 min |
| 1C-V3 | ID selection and reopened receipt | Full receipt ID is highlighted; reopened details remain clear and match the original receipt | 1–2 min |
| 1C-V4 | Deadline confirmation and receipt | 00:00 and the time-ended message are clear; final receipt explains server-accepted responses and shows 1 of 2, excluding the unsent change | 2–3 min |
| 1C-V5 | Narrow/200% top and scrolled views for both models | Heading and labels remain readable; ID wraps; selection, refresh and Exit actions remain reachable through vertical scrolling | 3–4 min |
| 1C-V6 | Completed gateway and candidate portal | Gateway receipt entry matches the desktop theme; portal shows submitted records without scores, grading state or automatic result promises | 2–3 min |

The user's first 1C reply requested changes to result visibility and completion,
not acceptance of the six groups. The revised receipt closes after one minute and
shows no grading information. Report which group needs a change, or confirm the
revised screens look correct. The user subsequently confirmed “Yes thats good now
next section”; all six observations and 1C acceptance are checked in the
[feature checklist](feature-checklist.md). The local gallery URL may change
when reopened; its latest URL/PID is in `submission-gallery.json`.

## Repeatable setup and test commands

From `C:\projects\DOA\assessment-platform`, with Docker and Node/Go available:

```powershell
.\scripts\test-attempt-access.ps1
Push-Location .\lockdown-client
npm run build
Pop-Location
# Uses the existing isolated review manifest; never the original platform.
.\scripts\start-submission-review.ps1
.\scripts\new-checkpoint-review-fixtures.ps1
node .\scripts\check-submission-delivery.cjs
# Creates another fresh fixture pair and runs both built-desktop flows.
.\scripts\test-submission-review-ui.ps1
```

The disposable suite removes its test containers and does not replace the active
review manifest. If no base review exists, run `start-attempt-review.ps1` first.
The outage test stops/restores only the review broker and restarts its grader;
synthetic authoring changes are restored on completion/error.

For the built portal gateway, retain the existing preview, or build the portal
and run `open-attempt-review-portal.ps1`. Stop its exact verified preview process
before rebuilding on Windows. Run the gateway check, then the gallery:

```powershell
$review = Get-Content .attempt-access-review/latest.json -Raw | ConvertFrom-Json
$portal = Get-Content (Join-Path $review.directory 'portal-preview.json') -Raw | ConvertFrom-Json
foreach ($mode in @('receipt', 'candidate')) {
  $gatewayArguments = @(('"' + (Join-Path $PWD 'scripts/check-attempt-review-gateway.cjs') + '"'), "--$mode", '--portal-url', $portal.url)
  $check = Start-Process -FilePath .\lockdown-client\node_modules\electron\dist\electron.exe -ArgumentList $gatewayArguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $review.directory "submission-$mode-portal.stdout.log") -RedirectStandardError (Join-Path $review.directory "submission-$mode-portal.stderr.log")
  if ($check.ExitCode -ne 0) { throw 'Portal check failed; inspect its logs' }
}
.\scripts\open-checkpoint-review-gallery.ps1 -Section 1C
```

## Next boundary

1C is accepted and 1D continuation is authorized. Worker processing deadlines, bounded
retry/dead-letter queues, automatic consumer reconnect and health/alerts remain
pending. Cold offline paper bootstrap remains outside completed recovery scope.
Two earlier 1A observations remain open: Candidate Login listing visual review
and actual archived 1.0.0 detection. That archive has no version probe; simulated
warnings do not establish actual detection or distribution.

No target migration, installer publication or production deployment was performed.
