// Run with the existing Electron executable to exercise native Chromium fetch,
// rather than Node fetch or an injected transport. --renewal uses a separate
// sample attempt for a real 16-minute start/renewal/submission check.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const ts = require('../lockdown-client/node_modules/typescript')

const repoRoot = join(__dirname, '..')
const review = JSON.parse(readFileSync(join(repoRoot, '.attempt-access-review/latest.json'), 'utf8'))
const renewalMode = process.argv.includes('--renewal')
const fixtures = JSON.parse(readFileSync(join(review.directory, renewalMode ? 'renewal-fixtures.json' : 'fixtures.json'), 'utf8'))
const source = readFileSync(join(repoRoot, 'lockdown-client/src/renderer/src/services/AttemptClient.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleURL = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const timeout = setTimeout(() => { console.error('Renderer check exceeded its time limit.'); app.exit(1) }, renewalMode ? 19 * 60_000 : 30_000)
  let progressTimer
  try {
    await window.loadURL('about:blank')
    if (renewalMode) {
      progressTimer = setInterval(async () => {
        try {
          const progress = await window.webContents.executeJavaScript('globalThis.renewalProgress ?? null')
          if (progress) {
            writeFileSync(join(review.directory, 'renewal-progress.json'), JSON.stringify(progress, null, 2))
            console.log(`Renewal review: ${progress.elapsed_seconds}s elapsed; ${progress.question_checks} authorized paper checks; ${progress.credential_updates} credentials issued.`)
          }
        } catch (error) { console.error(`Progress read failed: ${error.message}`) }
      }, 30_000)
    }
    const checks = await window.webContents.executeJavaScript(`(async () => {
      const { AttemptClient } = await import(${JSON.stringify(moduleURL)});
      const fixtures = ${JSON.stringify(fixtures)};
      const credentialExpiries = [];
      const client = new AttemptClient(${JSON.stringify(`${review.gateway_url}/api`)}, async token => {
        if (token) credentialExpiries.push(JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp);
      });
      const checks = [];
      if (${renewalMode}) {
        const expect = (condition, message) => { if (!condition) throw new Error(message); };
        await client.signIn(fixtures.candidate_a, fixtures.password);
        await client.authorize(fixtures.event_invitation);
        const path = '/exam/sessions/' + fixtures.session_id;
        const unlock = await client.request(path + '/unlock', { method: 'POST', body: JSON.stringify({passcode: fixtures.event_code}) });
        expect(unlock.status === 200, 'Elapsed review unlock failed: ' + unlock.status);
        const unlockData = await unlock.json();
        const firstExpiry = Date.parse(unlockData.expires_at);
        const start = await client.request(path + '/start', {method:'POST'});
        expect(start.status === 200, 'Elapsed review start failed: ' + start.status);
        const startData = await start.json();
        const started = performance.now();
        const initialPaper = await client.request(path + '/questions');
        expect(initialPaper.status === 200, 'Initial paper load failed: ' + initialPaper.status);
        let paper = await initialPaper.json();
        const questionIds = JSON.stringify(paper.questions.map(question => question.question_id));
        expect(paper.questions.length === 2, 'Expected the two-question review paper.');
        let questionChecks = 1;
        const updateProgress = () => { globalThis.renewalProgress = {
          phase:'running', session_id:fixtures.session_id, started_at:startData.started_at,
          first_credential_expires_at:unlockData.expires_at,
          elapsed_seconds:Math.floor((performance.now() - started) / 1000),
          question_checks:questionChecks, credential_updates:credentialExpiries.length,
          latest_check_at:new Date().toISOString()
        }; };
        updateProgress();
        while (performance.now() - started < 16 * 60_000) {
          await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 16 * 60_000 - (performance.now() - started))));
          await client.refresh();
          const response = await client.request(path + '/questions');
          expect(response.status === 200, 'Paper access interrupted: HTTP ' + response.status);
          paper = await response.json();
          expect(JSON.stringify(paper.questions.map(question => question.question_id)) === questionIds, 'The assigned paper changed during renewal.');
          questionChecks++;
          updateProgress();
        }
        expect(Date.now() > firstExpiry, 'The original token expiry has not passed.');
        expect(credentialExpiries.some(expiry => expiry * 1000 > firstExpiry + 60_000), 'The credential did not renew naturally.');
        const repeatStart = await client.request(path + '/start', {method:'POST'});
        expect(repeatStart.status === 200, 'Repeat start check failed.');
        const repeatData = await repeatStart.json();
        expect(repeatData.started_at === startData.started_at && repeatData.timer_expires_at === startData.timer_expires_at, 'Renewal or repeated start reset the exam timer.');
        const answers = paper.questions.map(question => question.question_type === 'FIB'
          ? {question_id:question.question_id,typed_response:'Elapsed review answer'}
          : {question_id:question.question_id,selected_option_ids:[question.options[0].id]});
        const submitted = await client.request(path + '/submit', {method:'POST',body:JSON.stringify({answers})});
        expect(submitted.status === 202, 'Submission after elapsed renewal failed: HTTP ' + submitted.status);
        globalThis.renewalProgress = {...globalThis.renewalProgress,phase:'passed'};
        return { checks:[
          'Native renderer start and two-question paper load',
          'Uninterrupted authorized paper access for at least 16 elapsed minutes',
          'Natural credential renewal across the original 15-minute expiry',
          'Original paper order and server timer preserved',
          'Filled submission accepted after elapsed credential renewal'
        ], elapsed_seconds:(performance.now() - started) / 1000,
          question_checks:questionChecks, credential_updates:credentialExpiries.length,
          session_id:fixtures.session_id, started_at:startData.started_at,
          timer_expires_at:startData.timer_expires_at, first_credential_expires_at:unlockData.expires_at,
          latest_credential_expires_at:new Date(Math.max(...credentialExpiries) * 1000).toISOString()
        };
      }
      try {
        await client.signIn(fixtures.candidate_a, 'incorrect');
        throw new Error('Wrong password was unexpectedly accepted.');
      } catch (error) {
        if (!error.message.includes('Invalid email or password')) throw error;
        checks.push('Wrong password returns the API authentication error');
      }
      await client.signIn(fixtures.candidate_a, fixtures.password);
      checks.push('Assigned candidate sign-in succeeds with native browser fetch');
      const assessments = await client.assignedAssessments();
      if (!Array.isArray(assessments) || !assessments.some(item => item.invitation_token === fixtures.event_invitation)) {
        throw new Error('Assigned event was not returned.');
      }
      checks.push('Assigned assessment list loads');
      await client.authorize(fixtures.event_invitation);
      checks.push('Invitation exchange succeeds');
      await client.refresh(true);
      checks.push('Forced credential renewal succeeds');
      const questions = await client.request('/exam/sessions/' + fixtures.session_id + '/questions');
      if (questions.status !== 403) throw new Error('Questions should be forbidden before unlock: ' + questions.status);
      checks.push('Scoped request reaches API and respects the unlock policy');
      return checks;
    })()`)
    clearInterval(progressTimer)
    clearTimeout(timeout)
    const { checks: testNames, ...details } = renewalMode ? checks : {checks}
    const report = { verified_at: new Date().toISOString(), runtime: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`, ...details, tests: testNames.map(test => ({ test, result: 'PASS' })) }
    writeFileSync(join(review.directory, renewalMode ? 'renewal-results.json' : 'renderer-results.json'), JSON.stringify(report, null, 2))
    if (renewalMode) {
      writeFileSync(join(review.directory, 'renewal-progress.json'), JSON.stringify({
        phase: 'passed', session_id: details.session_id, started_at: details.started_at,
        first_credential_expires_at: details.first_credential_expires_at,
        elapsed_seconds: Math.floor(details.elapsed_seconds), question_checks: details.question_checks,
        credential_updates: details.credential_updates, latest_check_at: report.verified_at
      }, null, 2))
    }
    testNames.forEach(check => console.log(`PASS ${check}`))
    app.exit(0)
  } catch (error) {
    console.error(error.stack || error.message)
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
