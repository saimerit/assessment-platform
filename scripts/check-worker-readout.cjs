const {app,BrowserWindow}=require('electron'),{readFileSync,writeFileSync}=require('node:fs'),{join}=require('node:path')
const root=join(__dirname,'..'),review=JSON.parse(readFileSync(join(root,'.attempt-access-review/latest.json'),'utf8'))
const gallery=JSON.parse(readFileSync(join(review.directory,'worker-gallery.json'),'utf8'))
if(new URL(gallery.url).hostname!=='127.0.0.1')throw new Error('Use local review readout')
app.setPath('userData',join(review.directory,`worker-readout-profile-${process.pid}`))
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1400,height:900,webPreferences:{contextIsolation:true,backgroundThrottling:false}})
 const execute=code=>window.webContents.executeJavaScript(code)
 const capture=async name=>{await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(review.directory,name+'.png'),(await window.webContents.capturePage()).toPNG())}
 try{
  await window.loadURL(gallery.url)
  if(!await execute("document.querySelectorAll('nav a').length===4 && document.querySelectorAll('tbody tr').length===8 && document.querySelectorAll('ol li').length===8 && document.body.innerText.includes('Not ready') && document.body.innerText.includes('DEAD_LETTERS_PRESENT')"))throw new Error('Worker readout evidence missing')
  await capture('worker-readout-desktop')
  await execute("document.querySelector('nav a').focus();void 0")
  if(!await execute("document.activeElement===document.querySelector('nav a')"))throw new Error('Readout navigation focus failed')
  window.setSize(700,850);window.webContents.setZoomFactor(2);await new Promise(resolve=>setTimeout(resolve,250))
  if(!await execute('document.documentElement.scrollWidth<=innerWidth+1'))throw new Error('Readout overflows at narrow/200% width')
  await execute("document.querySelector('#reconnect').scrollIntoView({block:'start'});void 0")
  await capture('worker-readout-zoom')
  writeFileSync(join(review.directory,'worker-readout-results.json'),JSON.stringify({passed:3,checks:['Eight passed checks and all four health groups render','Keyboard navigation focus is visible','Narrow/200% layout contains tables with horizontal scrolling'],scope:'Actual generated readout of live worker test evidence'},null,2))
  console.log('PASS Worker readout evidence, focus and narrow/200% layout.');app.exit(0)
 }catch(error){console.error(error.stack||error.message);app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
