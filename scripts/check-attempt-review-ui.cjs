// Exercise the built React desktop UI with native Chromium fetch against only
// the isolated review API. IPC supplies runtime config; no exam is started.
const { app, BrowserWindow, ipcMain } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const root = join(__dirname, '..')
const review = JSON.parse(readFileSync(join(root, '.attempt-access-review/latest.json'), 'utf8'))
const fixtures = JSON.parse(readFileSync(join(review.directory, 'ui-fixtures.json'), 'utf8'))
app.setPath('userData', join(review.directory, 'ui-browser-profile'))
process.env.ASSESSMENT_API_URL = `${review.gateway_url}/api`
process.env.PUBLIC_PORTAL_URL = review.gateway_url
let invitation = fixtures.event_invitation
const showPreview = process.argv.includes('--preview')
ipcMain.on('app:close', () => app.quit())
ipcMain.handle('exam:get-token', () => invitation)
ipcMain.handle('exam:set-attempt-token', () => undefined)
ipcMain.handle('exam:set-context', () => undefined)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { preload: join(root, 'lockdown-client/out/preload/index.js'), sandbox: false,
      contextIsolation: true, backgroundThrottling: false } })
  const checks = []
  const execute = code => window.webContents.executeJavaScript(code)
  const waitFor = async expression => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await execute(expression)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`UI condition timed out: ${expression}; ${await execute('document.body.innerText')}`)
  }
  const expect = (condition, message) => { if (!condition) throw new Error(message) }
  const input = async (selector, value) => {
    await execute(`(() => { const field = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const click = label => execute(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes(${JSON.stringify(label)})).click()`)
  const snapshot = async name => {
    await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(join(review.directory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadFile(join(root, 'lockdown-client/out/renderer/index.html'))
    await waitFor("document.body.innerText.includes('Verify candidate account')")
    for (const email of [fixtures.candidate_b, fixtures.candidate_c, fixtures.staff]) {
      await input('input[type=email]', email)
      await input('input[type=password]', fixtures.password)
      await click('Verify account & continue')
      await waitFor("document.querySelector('form')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('[role=alert]')")
      const state = await execute(`({error:document.querySelector('[role=alert]').innerText,
        password:document.querySelector('input[type=password]').value,
        identity:document.body.innerText.includes('Verify candidate account'),
        schedule:document.body.innerText.includes('Confirm your assessment')})`)
      expect(state.identity && !state.schedule && !state.password && state.error, `Wrong account reached schedule: ${email}`)
      checks.push({test:`Wrong account rejected in built desktop UI: ${email}`,result:'PASS',error:state.error})
    }
    await snapshot('ui-wrong-account')
    // Hold just the real login request until the busy snapshot and repeat-submit
    // checks finish, so compositor timing cannot outlast the simulated delay.
    await execute(`(() => { globalThis.loginRequests=0; globalThis.nativeFetch=globalThis.fetch;
      globalThis.fetch=async (...args) => {
        if(String(args[0]).endsWith('/auth/login')) {
          globalThis.loginRequests++;
          await new Promise(resolve=>{ globalThis.releaseLogin=resolve });
        }
        return globalThis.nativeFetch(...args);
      }; })()`)
    await input('input[type=email]', fixtures.candidate_a)
    await input('input[type=password]', 'wrong-password')
    await click('Verify account & continue')
    await waitFor("document.querySelector('form')?.getAttribute('aria-busy') === 'true'")
    expect(await execute("document.querySelector('button[type=submit]').disabled && document.querySelector('input[type=password]').disabled && document.body.innerText.includes('Verifying your account')"), 'Busy controls are not disabled/labeled')
    await snapshot('ui-login-loading')
    await execute("for(let i=0;i<5;i++) document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
    expect(await execute('globalThis.loginRequests === 1'), 'Repeated pending submissions sent extra requests')
    await execute('globalThis.releaseLogin()')
    await waitFor("document.querySelector('form')?.getAttribute('aria-busy') === 'false'")
    expect(await execute("globalThis.loginRequests === 1 && document.querySelector('input[type=password]').value === '' && !document.querySelector('button[type=submit]').disabled"), 'Duplicate login request or missing recovery')
    checks.push({test:'Loading disables credentials/submit, five repeat submits send one request, failed login clears password and restores controls',result:'PASS'})
    invitation = null
    await window.reload()
    await waitFor("document.body.innerText.includes('Candidate Login')")
    await execute(`(() => { globalThis.loginRequests=0;globalThis.nativeFetch=globalThis.fetch;
      globalThis.fetch=(...args)=>{if(String(args[0]).endsWith('/auth/login'))globalThis.loginRequests++;return globalThis.nativeFetch(...args);}; })()`)
    await click('Candidate Login')
    await waitFor("!!document.querySelector('input[type=email]')")
    await input('input[type=email]', fixtures.candidate_a)
    await input('input[type=password]', fixtures.password)
    await click('Sign In & View Exams')
    await waitFor("document.body.innerText.includes('Assigned assessments')")
    await snapshot('ui-assigned-assessments')
    await click('Review exam')
    await waitFor("!!document.querySelector('.assessment-dashboard')")
    expect(await execute("globalThis.loginRequests === 1 && !document.querySelector('input[type=password]') && document.body.innerText.includes('Continue to candidate details')"), 'Candidate Login caused redundant authentication or failed schedule')
    await snapshot('ui-account-schedule')
    checks.push({test:'Candidate Login without invitation paste lists assigned exam and reaches schedule with exactly one login',result:'PASS'})
    expect(await execute("document.querySelectorAll('.assessment-pattern-table tbody tr').length === 2 && document.querySelector('.assessment-pattern-table').innerText.includes('Multiple choice') && document.querySelector('.assessment-pattern-table').innerText.includes('Fill in the blank') && document.querySelector('.assessment-pattern-table tfoot').innerText.includes('2')"), 'Schedule table omitted question formats or counts')
    window.webContents.setZoomFactor(2)
    await snapshot('ui-account-schedule-200-percent')
    expect(await execute("document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth + 1"), 'Zoomed dashboard overflows its scrolling container')
    await execute("document.querySelector('.assessment-primary-action').scrollIntoView({block:'center'})")
    await snapshot('ui-account-schedule-200-percent-action')
    expect(await execute("(() => { const r=document.querySelector('.assessment-primary-action').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth; })()"), 'Zoomed continue button is not reachable')
    window.webContents.setZoomFactor(1)
    await window.setSize(680, 820)
    await snapshot('ui-account-schedule-narrow')
    expect(await execute("getComputedStyle(document.querySelector('.assessment-detail-grid')).gridTemplateColumns.split(' ').length === 1 && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth + 1"), 'Narrow dashboard failed to stack its cards')
    window.setSize(1200, 800)
    await execute("document.querySelector('main').scrollTop=0")
    await snapshot('ui-account-schedule')
    checks.push({test:'Dashboard shows both question formats/counts and fits narrow/200% views with a reachable continue button',result:'PASS'})
    await click('Continue to candidate details')
    await waitFor("document.querySelector('h2')?.textContent === 'Candidate details'")
    window.webContents.send('exam:token-loaded', fixtures.event_invitation)
    await waitFor("!!document.querySelector('.assessment-dashboard')")
    await snapshot('ui-account-schedule')
    checks.push({test:'Dashboard continue action opens candidate details and invitation reload restores schedule without a second login',result:'PASS'})
    const report = {verified_at:new Date().toISOString(),runtime:`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
      scope:'Built desktop React UI with native fetch and isolated API; no fullscreen/exam start',tests:checks}
    writeFileSync(join(review.directory, 'ui-results.json'),JSON.stringify(report,null,2))
    checks.forEach(check=>console.log(`PASS ${check.test}`))
    if (showPreview) {
      window.setTitle('Assessment schedule review')
      window.show()
      window.on('closed', () => app.quit())
    } else app.exit(0)
  } catch(error) { console.error(error.stack || error.message); app.exit(1) }
}).catch(error=>{ console.error(error); app.exit(1) })
