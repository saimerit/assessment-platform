// The built desktop renderer + native encrypted vault against the isolated API.
// Hardware/lockdown IPC are test doubles, so review never traps the user's desktop.
// Run --offline, restart the isolated API, then --resume for a real process restart.
const { app, BrowserWindow, ipcMain } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const Module = require('node:module')
const ts = require('../lockdown-client/node_modules/typescript')
const root = join(__dirname, '..')
const review = JSON.parse(readFileSync(join(root, '.attempt-access-review/latest.json'), 'utf8'))
const fixtures = JSON.parse(readFileSync(join(review.directory, 'checkpoint-fixtures.json'), 'utf8'))
const resume = process.argv.includes('--resume'), preview = process.argv.includes('--preview'), legacy = process.argv.includes('--legacy'), submitOnly = process.argv.includes('--submit-only')
const receiptReview=process.argv.includes('--receipt-review'),deadlineReview=process.argv.includes('--deadline-review'),reopenOnly=process.argv.includes('--reopen-only')
const autoCloseReview=process.argv.includes('--auto-close-review')
const label = legacy ? 'legacy' : 'event'
const invitation = legacy ? fixtures.legacy_invitation : fixtures.event_invitation
const base = `${review.gateway_url}/api`
const path = legacy ? `/assessments/${fixtures.blueprint_id}` : `/exam/sessions/${fixtures.session_id}`
process.env.ASSESSMENT_API_URL = base; process.env.PUBLIC_PORTAL_URL = review.gateway_url
app.setPath('userData', join(review.directory, `checkpoint-${label}-ui-profile`))
const loadNative = name => {
  const file=join(root,`lockdown-client/src/main/${name}.ts`),loaded=new Module(file,module)
  loaded.filename=file;loaded.paths=module.paths
  loaded._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file)
  return loaded.exports
}
const {AttemptRecoveryVault}=loadNative('AttemptRecoveryVault')
const {SubmissionExitTimer}=loadNative('SubmissionExitTimer')
const {verifySubmissionReceipt}=loadNative('SubmissionReceiptVerifier')
let vault, scope = '', token = '', window, verifiedScope, generation=0,closeStartedAt=0,closingReceipt=''
const exitTimer=new SubmissionExitTimer(()=>{
  if(autoCloseReview){
    const elapsed=performance.now()-closeStartedAt
    writeFileSync(join(review.directory,`submission-${label}-auto-close-results.json`),JSON.stringify({passed:1,elapsed_ms:elapsed,receipt:closingReceipt,scope:'Real native close timer and server receipt proof; hardware/kiosk enforcement are test doubles'},null,2))
    console.log(`PASS Application closed automatically after ${Math.round(elapsed)} ms.`)
  }
  app.quit()
})
ipcMain.handle('exam:get-token', () => invitation)
ipcMain.handle('exam:set-attempt-token', async (_event, value) => {
  exitTimer.cancel();generation++;token = value; if (!value) { scope = '';verifiedScope=null; return }
  const response = await fetch(`${base}/exam/identity`, { headers: { Authorization: `Bearer ${value}` } })
  if (!response.ok) throw new Error('Real API identity verification failed')
  const identity = await response.json()
  scope = JSON.stringify([base, identity.org_id, identity.student_id, identity.attempt_kind, identity.attempt_id])
  verifiedScope={kind:identity.attempt_kind,id:identity.attempt_id,assessmentId:identity.assessment_id,token,generation}
})
ipcMain.handle('exam:set-context', () => undefined)
ipcMain.handle('check-monitors', () => ({ count: 1, isSafe: true }))
ipcMain.handle('lockdown:engage', () => undefined)
ipcMain.handle('lockdown:release-after-submission', async (_event,receiptId) => {
  await verifySubmissionReceipt(base,verifiedScope,receiptId,()=>generation)
  closeStartedAt=performance.now();closingReceipt=receiptId
  return exitTimer.start(receiptId)
})
ipcMain.handle('recovery:read', () => { if (!scope) throw new Error('Verified scope required'); return vault.read(scope) })
ipcMain.handle('recovery:write', (_event, value) => { if (!scope) throw new Error('Verified scope required'); return vault.write(scope, value) })
ipcMain.handle('recovery:clear', () => { if (!scope) throw new Error('Verified scope required'); return vault.clear(scope) })
ipcMain.handle('quit-app', () => app.quit()); ipcMain.on('app:close', () => app.quit())
app.whenReady().then(async () => {
  vault = new AttemptRecoveryVault()
  window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: {
    preload: join(root, 'lockdown-client/out/preload/index.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false } })
  const execute = code => window.webContents.executeJavaScript(code)
  const expect = (condition, message) => { if (!condition) throw new Error(message) }
  const wait = async expression => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { if (await execute(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw new Error(`Timed out: ${expression}; ${await execute('document.body.innerText')}`)
  }
  const click = text => execute(`(() => { const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(text)})); if(!button||button.disabled)throw new Error('Unavailable button: '+${JSON.stringify(text)});button.click() })()`)
  const input = async (selector, value) => { await execute(`(() => { const field=document.querySelector(${JSON.stringify(selector)}); if(!field)throw new Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true})) })()`); await new Promise(resolve => setTimeout(resolve, 40)) }
  const capture = async name => { await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); writeFileSync(join(review.directory, `checkpoint-${label}-${name}.png`), (await window.webContents.capturePage()).toPNG()) }
  const saved = () => wait("document.querySelector('.attempt-save-status')?.classList.contains('is-saved')")
  const checkpoint = async () => {
    const response = await fetch(base + path + '/checkpoint', { headers: { Authorization: `Bearer ${token}` } }); expect(response.ok, `Checkpoint HTTP ${response.status}`); return response.json()
  }
  const receiptZoom = async () => {
    window.setSize(700,850);window.webContents.setZoomFactor(2)
    // Resize/zoom layout settles asynchronously; capture both ends of the scroll.
    await new Promise(resolve=>setTimeout(resolve,250))
    await execute("document.querySelector('main').scrollTop=0;void 0")
    await capture('receipt-zoom-top')
    await execute("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Exit application').scrollIntoView({block:'end'});void 0")
    await wait("(() => {const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Exit application').getBoundingClientRect(),m=document.querySelector('main').getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1&&b.top>=m.top&&b.bottom<=m.bottom+1})()")
    expect(await execute("document.documentElement.scrollWidth<=innerWidth+1"),'Receipt overflows at 200% zoom')
    await capture('receipt-zoom')
  }
  const checks = []
  try {
    await window.loadFile(join(root, 'lockdown-client/out/renderer/index.html'))
    window.webContents.setZoomFactor(1)
    await new Promise(resolve=>setTimeout(resolve,250))
    await wait("document.body.innerText.includes('Verify candidate account')")
    await input('input[type=password]', fixtures.password); await click('Verify account & continue')
    if(reopenOnly||autoCloseReview){
      await wait("document.body.innerText.includes('Assessment submitted')")
      await wait("document.querySelector('.submission-close-note strong')?.textContent.match(/^0[01]:[0-5][0-9]$/)")
      const expected=await execute("document.querySelector('.submission-receipt-id dd').textContent")
      await execute("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Exit application').scrollIntoView({block:'end'});void 0")
      await capture('receipt-countdown')
      if(autoCloseReview){
        expect(await execute("!document.body.innerText.includes('Grading status') && !document.body.innerText.includes('Refresh grading status')"),'Candidate grading controls remain visible')
        setTimeout(()=>{console.error('Automatic application close timed out');app.exit(1)},65000)
        console.log('Waiting for real native 60-second automatic application close.');return
      }
      window.show();window.focus();window.webContents.focus()
      await click('Select receipt ID');await wait("document.body.innerText.includes('Receipt ID selected')")
      expect(await execute('window.getSelection().toString()')===expected,'Receipt ID selection mismatch')
      await receiptZoom()
      const resultPath=join(review.directory,`submission-${label}-ui-results.json`)
      const result=JSON.parse(readFileSync(resultPath,'utf8'));result.zoom_verified_at=new Date().toISOString()
      writeFileSync(resultPath,JSON.stringify(result,null,2))
      console.log('PASS Receipt ID selection and visible exit control at narrow/200% zoom.');app.exit(0);return
    }

    await wait(resume ? "document.body.innerText.includes('Resume your exam')" : "document.body.innerText.includes('Continue to candidate details')"); await click(resume ? 'Resume your exam' : 'Continue to candidate details')
    await wait("document.body.innerText.includes('Candidate details')")
    const emptyFields = await execute("Array.from(document.querySelectorAll('main section input')).map((field,index)=>{field.id='review-detail-'+index;return {id:field.id,empty:!field.value,type:field.type}}).filter(field=>field.empty)")
    for (const field of emptyFields) await input('#' + field.id, field.type==='tel' ? '9999999999' : 'TEST-RECOVERY')
    await click('Continue to honor code'); await wait("document.body.innerText.includes('Honor code')")
    await click('I accept and agree')
    await wait("document.body.innerText.includes('Continue to tutorial')"); await click('Continue to tutorial')
    if (resume) await click('Resume & review questions')
    else { await input('input[type=password]', legacy ? fixtures.legacy_code : fixtures.event_code); await click('Verify passcode & review questions') }
    await wait("document.body.innerText.includes('Engage lockdown')"); await click('Engage lockdown')
    await wait("!!document.querySelector('.attempt-save-status')"); await saved()
    const paperResponse = legacy ? null : await fetch(base + path + '/questions', { headers: { Authorization: `Bearer ${token}` } })
    const paper = legacy ? null : await paperResponse.json()
    const start = await checkpoint()
    if(receiptReview||deadlineReview){
      const {execFileSync}=require('node:child_process')
      const grader=review.network+'-submission-grader'
      const docker=(...args)=>execFileSync('docker',args,{stdio:'pipe',timeout:20000})
      const finalScope=scope
      await click('Text response');await wait("!!document.querySelector('input[aria-label=\"Your answer\"]')")
      await input('input[aria-label="Your answer"]','My conflict response');await click('Mark for review');await saved()
      if(deadlineReview){
        await execute(`globalThis.receiptNativeFetch=globalThis.fetch;globalThis.fetch=(...args)=>((String(args[0]).endsWith('/checkpoint')&&args[1]?.method==='PUT')||String(args[0]).endsWith('/receipt'))?Promise.reject(new TypeError('Review: disconnected finalization transport')):globalThis.receiptNativeFetch(...args);void 0`)
        await input('input[aria-label="Your answer"]','Unsent draft at the deadline')
        const untilDeadline=Date.parse(start.timer_expires_at)-Date.now()
        console.log('Waiting for the real one-minute review deadline.')
        await new Promise(resolve=>setTimeout(resolve,Math.max(0,untilDeadline)+1200))
        await wait("document.body.innerText.includes('Awaiting submission confirmation')")
        expect(await execute("document.querySelector('input[aria-label=\"Your answer\"]')?.disabled===true"),'Deadline left the answer editable')
        await capture('deadline-pending')
        expect((await vault.read(finalScope))!==null,'Unconfirmed deadline receipt cleared recovery')
        await execute('globalThis.fetch=globalThis.receiptNativeFetch;void 0');await click('Retry confirmation')
        await wait("document.body.innerText.includes('Assessment submitted')")
        await capture('deadline-receipt')
        const received=await fetch(base+path+'/receipt',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json())
        expect(received.reason==='DEADLINE'&&received.answered_count===1,'Deadline receipt included unsent work')
        checks.push('Real deadline freezes inputs, retains unknown recovery, then retrieves the automatically finalized receipt')
      }else{
        docker('stop',grader)
        await execute(`globalThis.receiptNativeFetch=globalThis.fetch;globalThis.lostSubmission=false;globalThis.fetch=async (...args)=>{if(globalThis.lostSubmission&&String(args[0]).endsWith('/receipt'))throw new TypeError('Review: confirmation unavailable');const response=await globalThis.receiptNativeFetch(...args);if(String(args[0]).endsWith('/submit')&&!globalThis.lostSubmission){globalThis.lostSubmission=true;throw new TypeError('Review: response lost after commit')}return response};void 0`)
        await click('Submit assessment');await click('Confirm submit')
        await wait("document.body.innerText.includes('Awaiting submission confirmation')");await capture('submission-pending')
        expect((await vault.read(finalScope))!==null,'Lost response cleared recovery')
        await execute('globalThis.fetch=globalThis.receiptNativeFetch;void 0');await click('Retry confirmation')
        await wait("document.body.innerText.includes('Assessment submitted')");await capture('receipt-confirmed')
        checks.push('Lost committed response shows pending confirmation; retry retrieves the durable receipt and then clears recovery')
        docker('start',grader)
        expect(await execute("!document.body.innerText.includes('Grading status') && !document.body.innerText.includes('Refresh grading status')"),'Candidate grading controls remain visible')
        checks.push('Confirmed receipt displays without waiting for grading and contains no grading controls')
      }
      await wait("document.querySelector('.submission-close-note strong')?.textContent.match(/^0[01]:[0-5][0-9]$/)")
      const receiptId=await execute("document.querySelector('.submission-receipt-id dd').innerText")
      await click('Select receipt ID');await wait("document.body.innerText.includes('Receipt ID selected')")
      expect(await execute('window.getSelection().toString()')===receiptId,'Receipt selection failed');expect(await vault.read(finalScope)===null,'Received receipt retained journal')
      await execute("document.querySelector('.submission-receipt-id dd').focus();void 0")
      expect(await execute('window.getSelection().toString()')===receiptId,'Focused receipt ID was not selected')
      await capture('receipt-selected')
      checks.push('Receipt ID selection works and confirmed submission deletes encrypted recovery')
      await window.reload();await wait("document.body.innerText.includes('Verify candidate account')")
      await input('input[type=password]',fixtures.password);await click('Verify account & continue')
      await wait("document.body.innerText.includes('Assessment submitted')")
      expect(await execute("document.querySelector('.submission-receipt-id dd').innerText")===receiptId,'Reload changed the receipt ID')
      await capture('receipt-reopened')
      checks.push('Reload/sign-in retrieves the same receipt without starting or re-unlocking the exam')
      await receiptZoom()
      checks.push('Receipt controls remain reachable at narrow width and 200% zoom')
      writeFileSync(join(review.directory,`submission-${label}-ui-results.json`),JSON.stringify({passed:checks.length,checks,receipt:receiptId,scope:'Built renderer, native encrypted vault and live isolated API; kiosk/hardware enforcement are test doubles'},null,2))
      console.log(JSON.stringify({model:label,passed:checks.length,checks}));app.exit(0);return
    }
    if (submitOnly) {
      const finalScope = scope
      await click('Submit assessment'); await click('Confirm submit'); await wait("document.body.innerText.includes('Assessment submitted')")
      expect(await vault.read(finalScope)===null, 'Recovery buffer was not cleared')
      const resultFile = join(review.directory, `checkpoint-${label}-ui-results.json`)
      const result = JSON.parse(readFileSync(resultFile, 'utf8'))
      result.checks.push('Revision-only submission succeeds and deletes the encrypted local buffer'); result.passed=result.checks.length
      writeFileSync(resultFile, JSON.stringify(result,null,2)); console.log(JSON.stringify({phase:'submit',model:label,passed:1})); app.exit(0); return
    }
    if (!resume) {
      const textButton = await execute("Array.from(document.querySelectorAll('main section button')).find(button=>button.textContent.includes('Text response'))?.textContent")
      expect(textButton, 'Review text question missing'); await click('Text response')
      await wait("!!document.querySelector('input[aria-label=\"Your answer\"]')")
      await input('input[aria-label="Your answer"]', 'Server saved response'); await click('Mark for review'); await saved()
      await click('Question overview'); await click('Choose options')
      await click('Option one'); await saved()
      expect((await checkpoint()).answers.some(answer => answer.selected_option_ids.length === 1), 'MCQ save missing')
      await click('Option one'); await saved()
      await click('Question overview'); await click('Text response'); await input('input[aria-label="Your answer"]', ''); await saved()
      await click('Question overview'); await saved()
      expect(await execute("document.body.innerText.includes('0 of 2 answered')"), 'Cleared/blank responses counted as answered')
      checks.push('MCQ toggle clear and blank text durably save; answered count returns to zero')
      await click('Text response'); await input('input[aria-label="Your answer"]', 'Acknowledged before restart'); await saved()
      await capture('saved')
      await execute(`globalThis.originalFetch=globalThis.fetch;globalThis.fetch=(...args)=>String(args[0]).endsWith('/checkpoint')&&args[1]?.method==='PUT'?Promise.reject(new TypeError('Review: disconnected save transport')):globalThis.originalFetch(...args);void 0`)
      await input('input[aria-label="Your answer"]', 'Draft after disconnect')
      await wait("document.querySelector('.attempt-save-status')?.classList.contains('is-offline')")
      await capture('offline')
      const encoded = await vault.read(scope)
      expect(encoded && Object.values(JSON.parse(encoded).pending).some(answer=>answer.typed_response==='Draft after disconnect'), 'Encrypted pending draft missing')
      checks.push('Disconnected edit remains visible and is written to native encrypted recovery storage')
      writeFileSync(join(review.directory, `checkpoint-${label}-restart-before.json`), JSON.stringify({ timer_expires_at: start.timer_expires_at, started_at: start.started_at, paper: paper?.questions.map(q=>q.question_id), checks }, null, 2))
      console.log(JSON.stringify({ phase: 'offline', model: label, passed: checks.length, checks })); app.exit(0)
    } else {
      const before = JSON.parse(readFileSync(join(review.directory, `checkpoint-${label}-restart-before.json`), 'utf8'))
      expect(start.started_at===before.started_at && start.timer_expires_at===before.timer_expires_at, 'Process/API restart changed original timer')
      if (paper) expect(JSON.stringify(paper.questions.map(q=>q.question_id))===JSON.stringify(before.paper), 'Restart changed original paper/order')
      await wait("document.querySelector('input[aria-label=\"Your answer\"]')?.value==='Draft after disconnect'")
      expect(await execute("document.body.innerText.includes('Flagged for review') && document.body.innerText.includes('Recovered your saved progress')"), 'Review flag/navigation/recovery label not restored')
      expect(start.answers.some(answer=>answer.typed_response==='Draft after disconnect'), 'Draft not replayed to real PostgreSQL')
      checks.push('New Electron process restores encrypted draft, review flag/navigation and pinned paper/timer after API restart')
      await capture('recovered')
      // Hold a real save until its saving layout is captured, then release it.
      await execute(`globalThis.originalFetch=globalThis.fetch;globalThis.fetch=async (...args)=>{if(String(args[0]).endsWith('/checkpoint')&&args[1]?.method==='PUT')await new Promise(resolve=>{globalThis.releaseSave=resolve});return globalThis.originalFetch(...args)};void 0`)
      await input('input[aria-label="Your answer"]', 'Final saved response'); await wait("typeof globalThis.releaseSave==='function'"); await capture('saving')
      await execute('globalThis.releaseSave();globalThis.fetch=globalThis.originalFetch;void 0'); await saved()
      // Return one explicit failure; a user retry must recover through the actual endpoint.
      await execute(`globalThis.fetch=(...args)=>String(args[0]).endsWith('/checkpoint')&&args[1]?.method==='PUT'?Promise.resolve(new Response(JSON.stringify({error:'Review: save service unavailable'}),{status:503})):globalThis.originalFetch(...args);void 0`)
      await input('input[aria-label="Your answer"]', 'Retry saved response'); await wait("document.querySelector('.attempt-save-status')?.classList.contains('is-error')"); await capture('error')
      await execute('globalThis.fetch=globalThis.originalFetch;void 0'); await click('Retry sync'); await saved()
      checks.push('Saving label and save error appear; Retry sync recovers without losing the typed response')
      const remote = await checkpoint()
      const typed = remote.answers.find(answer=>answer.typed_response!==null)
      const concurrent = await fetch(base + path + '/checkpoint', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: require('node:crypto').randomUUID(), base_revision: remote.revision, answers: [{ ...typed, typed_response: 'Response saved in another session' }] }) })
      expect(concurrent.ok, 'Concurrent writer failed')
      await input('input[aria-label="Your answer"]', 'My conflict response')
      await wait("document.querySelector('.attempt-save-status')?.classList.contains('is-conflict')"); await capture('conflict')
      expect(await execute("document.querySelector('.attempt-save-status').innerText.includes('My conflict response') && document.querySelector('.attempt-save-status').innerText.includes('Response saved in another session')"), 'Conflict choices do not show both responses')
      await click('Keep my current changes'); await saved()
      expect((await checkpoint()).answers.some(answer=>answer.typed_response==='My conflict response'), 'Explicit conflict choice was not saved')
      checks.push('Concurrent same-question edits show both responses; explicit local choice saves without silent overwrite')
      window.setSize(700, 850); await execute("document.querySelector('main').scrollTop=document.querySelector('main').scrollHeight")
      await capture('narrow'); expect(await execute('document.documentElement.scrollWidth<=innerWidth+1'), 'Narrow layout overflows')
      window.webContents.setZoomFactor(2); await execute("document.querySelector('main').scrollTop=document.querySelector('main').scrollHeight"); await capture('zoom')
      expect(await execute("(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Submit assessment');button.scrollIntoView();const r=button.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})()"), 'Submit unreachable at 200% zoom')
      checks.push('Narrow viewport and 200% zoom keep save status and primary action reachable')
      window.webContents.setZoomFactor(1); window.setSize(1200,850)
      if (!preview) {
        const finalScope = scope
        await click('Submit assessment'); await click('Confirm submit'); await wait("document.body.innerText.includes('Assessment submitted')")
        expect(await vault.read(finalScope)===null, 'Recovery buffer was not cleared')
        checks.push('Revision-only submission succeeds and deletes the encrypted local buffer')
      }
      writeFileSync(join(review.directory, `checkpoint-${label}-ui-results.json`), JSON.stringify({ phase: 'resume', model: label, passed: checks.length, checks, limitation: 'Built renderer/native vault/live API; hardware and kiosk IPC are test doubles. Visual acceptance remains user review.' }, null, 2))
      console.log(JSON.stringify({ phase: 'resume', model: label, passed: checks.length, checks }))
      if (preview) { window.show(); return }
      app.exit(0)
    }
  } catch (error) { if(receiptReview){try{require('node:child_process').execFileSync('docker',['start',review.network+'-submission-grader'],{stdio:'pipe'})}catch{}} console.error(error); console.error(await execute('document.body.innerText').catch(()=>'')); app.exit(1) }
})
app.on('will-quit',()=>exitTimer.cancel())
