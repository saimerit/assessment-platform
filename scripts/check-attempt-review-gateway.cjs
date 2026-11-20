// Gateway UI verification with an explicitly simulated version probe. The
// archived 1.0.0 app has no probe; this is not an old-installer acceptance test.
const { app, BrowserWindow, session } = require('electron')
const { createServer } = require('node:http')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const root = join(__dirname, '..')
const review = JSON.parse(readFileSync(join(root, '.attempt-access-review/latest.json'), 'utf8'))
const receiptMode=process.argv.includes('--receipt')
const candidateMode=process.argv.includes('--candidate')
const fixtures = JSON.parse(readFileSync(join(review.directory, receiptMode||candidateMode?'checkpoint-fixtures.json':'ui-fixtures.json'), 'utf8'))
const portalURLIndex = process.argv.indexOf('--portal-url')
const portalURL = portalURLIndex >= 0 ? process.argv[portalURLIndex + 1] : review.gateway_url
const portalOrigin = new URL(portalURL)
if (portalOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(portalOrigin.hostname)) throw new Error('Use a loopback review portal URL')
app.setPath('userData', join(review.directory, `gateway-browser-profile-${process.pid}`))
let detected = false
let simulatedVersion='1.0.0'
const probe = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Private-Network', 'true')
  response.setHeader('Content-Type', 'application/json')
  response.writeHead(detected ? 200 : 503)
  response.end(JSON.stringify(detected ? {version:simulatedVersion,status:'READY'} : {error:'No legacy version probe'}))
})
app.whenReady().then(async () => {
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://127.0.0.1:48991/version', `${portalOrigin.origin}/api/*`]}, (details, callback) => {
    if (details.url === 'http://127.0.0.1:48991/version') callback({redirectURL:`http://127.0.0.1:${probe.address().port}/version`})
    else if (portalOrigin.origin !== review.gateway_url) callback({redirectURL:review.gateway_url + new URL(details.url).pathname})
    else callback({})
  })
  const window = new BrowserWindow({show:false,width:1100,height:850,webPreferences:{contextIsolation:true,backgroundThrottling:false}})
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}))
  const waitFor = async expression => {
    const deadline = Date.now()+15000
    while(Date.now()<deadline) {
      if(await window.webContents.executeJavaScript(expression)) return
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    throw new Error(`Gateway condition timed out: ${expression}; ${await window.webContents.executeJavaScript('document.body.innerText')}`)
  }
  const snapshot = async name => {
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(join(review.directory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  try {
    if(candidateMode){
      const response=await fetch(review.gateway_url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:fixtures.candidate_a,password:fixtures.password})})
      const account=await response.json();if(!response.ok)throw new Error('Candidate privacy sign-in failed')
      // Chromium strips authorization across the standalone-preview redirect.
      // Restore only this synthetic account header on the known review API route.
      session.defaultSession.webRequest.onBeforeSendHeaders({urls:[review.gateway_url+'/api/candidate/*']},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,Authorization:'Bearer '+account.token}}))
      const listing=await fetch(review.gateway_url+'/api/candidate/assessments',{headers:{Authorization:'Bearer '+account.token}}).then(r=>r.json())
      if(!listing.assessments?.length||listing.assessments.some(a=>'score' in a||'evaluated_at' in a||a.status==='EVALUATED'))throw new Error('Candidate API exposed private grading')
      await window.loadURL(portalOrigin.origin+'/login')
      await window.webContents.executeJavaScript(`localStorage.setItem('token',${JSON.stringify(account.token)});localStorage.setItem('user',${JSON.stringify(JSON.stringify(account.user))});void 0`)
      await window.loadURL(portalOrigin.origin+'/candidate')
      await waitFor("document.body.innerText.includes('Completed assessments') && document.body.innerText.includes('SUBMITTED')")
      if(await window.webContents.executeJavaScript("document.body.innerText.includes('Score:') || document.body.innerText.includes('Grading complete') || document.body.innerText.includes('Results available')"))throw new Error('Candidate portal exposed private grading')
      await snapshot('submission-candidate-portal')
      await window.webContents.executeJavaScript("document.querySelector('main > section:last-child').scrollIntoView({block:'end'});void 0")
      await snapshot('submission-candidate-portal-records')
      writeFileSync(join(review.directory,'submission-candidate-privacy-results.json'),JSON.stringify({passed:2,tests:['Candidate API omits confidential results and internal grading state','Built candidate portal shows submitted records without grading or scores'],scope:'Built portal and real isolated API; publication/email delivery remain 3F'},null,2))
      console.log('PASS Candidate API and portal retain confidential results.');app.exit(0);return
    }
    const url = `${portalOrigin.origin}/exg/${fixtures.event_invitation}`
    await window.loadURL(url)
    await waitFor("document.body.innerText.includes('Not detected') && document.body.innerText.includes('I Have the Client')")
    if(receiptMode){
      await waitFor("document.body.innerText.includes('Your assessment is submitted') && document.body.innerText.includes('View Receipt')")
      await snapshot('submission-gateway-receipt')
    }
    await snapshot('gateway-no-probe')
    detected = true
    await window.reload()
    await waitFor("document.body.innerText.includes('Detected (v1.0.0)') && document.body.innerText.includes('Your client is outdated. Update to v1.3.0')")
    if (!await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('main')).display === 'flex' && getComputedStyle(document.querySelector('main > section')).backgroundColor === 'rgb(255, 255, 255)'")) throw new Error('Gateway theme styles were not applied')
    const links = await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('a')).map(a=>({label:a.innerText,href:a.getAttribute('href')}))")
    if(links.some(link=>link.label.includes('Launch Lockdown Client'))) throw new Error('Outdated client may launch from the gateway')
    await snapshot('gateway-old-version-simulation')
    window.webContents.setZoomFactor(2)
    await snapshot('gateway-old-version-200-percent')
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('a')).find(a=>a.innerText.includes('Update Lockdown')).scrollIntoView({block:'center'})")
    await snapshot('gateway-old-version-200-percent-action')
    if (!await window.webContents.executeJavaScript("(() => { const r=Array.from(document.querySelectorAll('a')).find(a=>a.innerText.includes('Update Lockdown')).getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth; })()")) throw new Error('Zoomed gateway update button is not reachable')
    window.webContents.setZoomFactor(1)
    window.setSize(500, 820)
    await snapshot('gateway-old-version-narrow')
    if (!await window.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth+1')) throw new Error('Narrow gateway has horizontal page overflow')
    window.setSize(1100, 850)
    await window.webContents.executeJavaScript('window.scrollTo(0,0)')
    await snapshot('gateway-old-version-simulation')
    writeFileSync(join(review.directory,'gateway-results.json'),JSON.stringify({verified_at:new Date().toISOString(),
      scope:'Real gateway UI; simulated unavailable / 1.0.0 probe responses',
      limitation:'Archived 1.0.0 build has no version probe. Genuine old-client update prompt remains unverified. No 1.3.0 installer published.',
      tests:[{test:'Unavailable probe shows Not detected and manual launch fallback',result:'PASS'},
        {test:'Simulated 1.0.0 probe shows 1.3.0 update requirement and hides launch action',result:'PASS'},
        {test:'Updated gateway fits a narrow viewport and keeps the update action reachable at 200% zoom',result:'PASS'}],links},null,2))
    if(receiptMode){
      simulatedVersion='1.3.0';await window.reload()
      await waitFor("document.body.innerText.includes('Open Client to View Receipt') && document.body.innerText.includes('Detected (v1.3.0)')")
      await snapshot('submission-gateway-receipt')
      writeFileSync(join(review.directory,'submission-gateway-results.json'),JSON.stringify({passed:3,tests:['Submitted invitation offers authenticated receipt entry','Outdated simulated client requires 1.3.0 before receipt entry','Matching simulated version permits receipt client entry'],limitation:'Version probe responses are simulated; archived old-client detection and deployment remain open'},null,2))
      console.log('PASS Completed gateway receipt entry and 1.3.0 compatibility.');app.exit(0);return
    }
    console.log('PASS Gateway unavailable-probe fallback and simulated old-version update warning. Actual 1.0.0 detection remains pending.')
    window.setTitle('1A review — simulated 1.0.0 update warning')
    window.show()
    window.on('closed',()=>app.quit())
  } catch(error) { console.error(error.stack || error.message); app.exit(1) }
}).catch(error=>{console.error(error);app.exit(1)})
app.on('will-quit',()=>probe.close())
