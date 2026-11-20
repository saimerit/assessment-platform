// Real isolated broker/workers/PostgreSQL, with a local SMTP sink only.
const {readFileSync,writeFileSync}=require('node:fs'),{join}=require('node:path'),{execFileSync,spawn}=require('node:child_process'),{randomUUID}=require('node:crypto')
const root=join(__dirname,'..'),review=JSON.parse(readFileSync(join(root,'.attempt-access-review/latest.json'),'utf8'))
const workers=JSON.parse(readFileSync(join(review.directory,'worker-review.json'),'utf8'))
if(!/^assessment-auth-review-[a-f0-9]{12}$/.test(review.network)||!/^assessment-auth-test-pg-[a-f0-9]{12}$/.test(review.postgres))throw new Error('Use isolated review targets')
for(const name of [workers.grader,workers.notification,workers.smtp_sink,review.submission_broker])if(!name.startsWith(review.network+'-'))throw new Error('Unexpected test target')
const api=review.network+'-api',broker=review.submission_broker
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000}).trim()
const sql=query=>docker('exec',review.postgres,'psql','-U','root','-d','assessment_attempt_auth_test','-At','-v','ON_ERROR_STOP=1','-c',query)
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),expect=(ok,msg)=>{if(!ok)throw new Error(msg)}
const checks=[],snapshots={}
const passed=label=>{checks.push(label);console.log("PASS "+label)}
async function json(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(4000)});return {status:r.status,data:await r.json()}}
async function wait(test,label,ms=45000){const until=Date.now()+ms;while(Date.now()<until){try{const value=await test();if(value)return value}catch{}await delay(200)}throw new Error('Timed out: '+label)}
const state=id=>sql(`SELECT state||'|'||attempts||'|'||COALESCE(last_error_code,'') FROM worker_jobs WHERE job_id='${id}'`)
const stats=()=>json(workers.smtp_url)
const mode=value=>json(workers.smtp_url+'/mode/'+value,{method:'POST'})
const publish=(queue,id,body,timestamp=Math.floor(Date.now()/1000))=>{
 const payload=JSON.stringify({properties:{message_id:id,delivery_mode:2,content_type:'application/json',timestamp},routing_key:queue,payload:typeof body==='string'?body:JSON.stringify(body),payload_encoding:'string'})
 const result=JSON.parse(docker('exec',api,'wget','-q','-O','-','--header=Authorization: Basic Z3Vlc3Q6Z3Vlc3Q=','--header=Content-Type: application/json','--post-data='+payload,`http://${broker}:15672/api/exchanges/%2F/amq.default/publish`))
 expect(result.routed,'Job was not routed')
}
const notification=(title='Worker verification')=>({event:'EXAM_INVITATION',recipient_email:'candidate@worker-recovery.test',candidate_name:'Synthetic candidate',exam_title:title,invitation_url:review.gateway_url+'/exg/test-only'})
const ready=async()=>{for(const url of [workers.grader_url,workers.notification_url])await wait(async()=>{const r=await json(url+'/readyz');return r.status===200&&r.data.ready},'worker readiness')}
async function apiRequest(path,token,body){return json(review.gateway_url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})}

(async()=>{
 let brokerStopped=false
 try {
  await ready();snapshots.healthy={grader:(await json(workers.grader_url+'/healthz')).data,notification:(await json(workers.notification_url+'/healthz')).data}
  const accepted=(await stats()).data.accepted,id=randomUUID(),body=notification('Idempotent local delivery')
  publish('notification_events',id,body)
  await wait(()=>state(id).startsWith('SUCCEEDED|1|'),'first local delivery')
  publish('notification_events',id,body);publish('notification_events',id,body)
  await delay(500);expect((await stats()).data.accepted===accepted+1,'Duplicate job sent another email')
  expect(sql(`SELECT count(*) FROM notification_logs WHERE job_id='${id}' AND status='SENT'`)==='1','Success audit was duplicated')
  passed('Committed notification redelivery is skipped with one local SMTP acceptance and one success audit')
  const malformed=randomUUID();publish('assessment_submissions',malformed,'{')
  await wait(()=>state(malformed).startsWith('DEAD_LETTER|1|INVALID_PAYLOAD'),'malformed grading job')
  const wrongVersion=randomUUID();publish('assessment_submissions',wrongVersion,{submission_id:randomUUID(),version:2})
  await wait(()=>state(wrongVersion).startsWith('DEAD_LETTER|1|INVALID_SUBMISSION_VERSION'),'invalid grading version')
  passed('Malformed and unsupported-version grading jobs reach durable dead letters without a requeue loop')
  await mode('fail');const failing=randomUUID();publish('notification_events',failing,notification('Bounded failure'))
  await wait(()=>state(failing).startsWith('RETRYING|1|'),'delayed notification retry')
  snapshots.retry=await wait(async()=>{const h=(await json(workers.notification_url+'/healthz')).data;return h.retry_messages>0&&h.failed_jobs>0?h:false},'retry health counters')
  docker('restart',workers.notification);await ready()
  await wait(()=>state(failing).startsWith('DEAD_LETTER|3|'),'exhausted notification',30000)
  await delay(1000);expect(state(failing).startsWith('DEAD_LETTER|3|'),'Worker restart reset the attempt budget')
  passed('SMTP failures retry after stored delays, retain the budget across worker restart and stop at three test attempts')
  await mode('stall');const stalled=randomUUID();publish('notification_events',stalled,notification('Timeout verification'),Math.floor(Date.now()/1000)-60)
  await wait(()=>state(stalled).startsWith('RETRYING|1|PROCESSING_TIMEOUT'),'SMTP processing timeout')
  await wait(async()=>{const h=(await json(workers.notification_url+'/healthz')).data;if(h.alerts.includes('QUEUE_AGE_HIGH')){snapshots.timeout=h;return true}},'queue age alert')
  await wait(()=>state(stalled).startsWith('DEAD_LETTER|3|PROCESSING_TIMEOUT'),'timeout exhausted',30000)
  passed('Stalled SMTP sockets close at the processing deadline, preserve original queue age and exhaust into dead letters')
  const fixtures=JSON.parse(readFileSync(join(review.directory,'checkpoint-fixtures.json'),'utf8'))
  const account=await apiRequest('/auth/login','',{email:fixtures.candidate_a,password:fixtures.password});expect(account.status===200,'Candidate fixture login failed')
  const legacyAccess=await apiRequest('/exam/access',account.data.token,{invitation_token:fixtures.legacy_invitation});expect(legacyAccess.status===200,'Legacy attempt access failed')
  const legacyPath='/assessments/'+fixtures.blueprint_id
  const legacyUnlock=await apiRequest(legacyPath+'/verify-passcode',legacyAccess.data.attempt_token,{passcode:fixtures.legacy_code});expect(legacyUnlock.status===200,'Legacy unlock failed')
  expect((await apiRequest(legacyPath+'/start',legacyUnlock.data.attempt_token,{})).status===200,'Legacy start failed')
  const hold=spawn('docker',['exec',review.postgres,'psql','-U','root','-d','assessment_attempt_auth_test','-v','ON_ERROR_STOP=1','-c',"BEGIN; LOCK TABLE answer_vault.attempt_snapshot_keys IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(2.5) /* worker-recovery-grade-lock */; COMMIT;"],{stdio:'ignore',windowsHide:true})
  const released=new Promise((resolve,reject)=>{hold.on('error',reject);hold.on('exit',code=>code===0?resolve():reject(new Error('Synthetic grading lock failed')))})
  await wait(()=>sql("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.relation='answer_vault.attempt_snapshot_keys'::regclass AND l.mode='AccessExclusiveLock' AND l.granted AND a.query LIKE '%worker-recovery-grade-lock%')")==='t','synthetic key lock')
  const legacySubmitted=await apiRequest(legacyPath+'/submit',legacyUnlock.data.attempt_token,{checkpoint_revision:0});expect(legacySubmitted.status===202,'Legacy submission failed')
  await wait(()=>state(legacySubmitted.data.submission_id).startsWith('RETRYING|1|PROCESSING_TIMEOUT'),'grading query deadline')
  await released
  await wait(()=>state(legacySubmitted.data.submission_id).startsWith('SUCCEEDED|2|'),'grading recovery after timeout')
  expect(sql(`SELECT count(*) FROM candidate_results WHERE instance_id='${fixtures.instance_id}'`)==='1','Timeout recovery produced duplicate legacy results')
  passed('Blocked grading SQL cancels at the processing deadline, then retries once to one effective legacy result')
  await mode('fail');const reconnecting=randomUUID();publish('notification_events',reconnecting,notification('Recover pending retry'))
  await wait(()=>state(reconnecting).startsWith('RETRYING|1|'),'pending retry before outage')
  const before={grader:JSON.parse(docker('inspect',workers.grader))[0].State.StartedAt,notification:JSON.parse(docker('inspect',workers.notification))[0].State.StartedAt}
  docker('stop',broker);brokerStopped=true
  await wait(async()=>{const h=await json(workers.grader_url+'/readyz');return h.status===503&&!h.data.broker_connected},'grader disconnect readiness')
  await wait(async()=>{const h=await json(workers.notification_url+'/readyz');if(h.status===503&&!h.data.broker_connected){snapshots.disconnected=h.data;return true}},'notification disconnect readiness')
  await mode('accept')
  // The API still accepts an immutable submission while the workers/broker are down.
  const access=await apiRequest('/exam/access',account.data.token,{invitation_token:fixtures.event_invitation});expect(access.status===200,'Attempt access failed')
  const path='/exam/sessions/'+fixtures.session_id
  const unlock=await apiRequest(path+'/unlock',access.data.attempt_token,{passcode:fixtures.event_code});expect(unlock.status===200,'Unlock failed')
  const token=unlock.data.attempt_token;expect((await apiRequest(path+'/start',token,{})).status===200,'Start failed')
  const submitted=await apiRequest(path+'/submit',token,{checkpoint_revision:0});expect(submitted.status===202,'Broker outage prevented receipt')
  docker('start',broker);brokerStopped=false;await ready()
  await wait(()=>state(reconnecting).startsWith('SUCCEEDED|'),'retry lost during broker outage',60000)
  await wait(()=>sql(`SELECT grading_status FROM attempt_submissions WHERE id='${submitted.data.submission_id}'`)==='GRADED','grading after automatic reconnect',60000)
  for(const [key,name] of [['grader',workers.grader],['notification',workers.notification]])expect(JSON.parse(docker('inspect',name))[0].State.StartedAt===before[key],'Recovery required restarting '+key)
  snapshots.recovered={grader:(await json(workers.grader_url+'/healthz')).data,notification:(await json(workers.notification_url+'/healthz')).data}
  expect(snapshots.recovered.grader.connections_total>=2&&snapshots.recovered.notification.connections_total>=2,'Consumers did not rebuild their connections')
  passed('Broker outage marks consumers not ready; pending retry and grading recover on new connections without restarting either worker')
  const receiptID=submitted.data.submission_id,outbox=JSON.parse(sql(`SELECT payload::text FROM submission_outbox WHERE submission_id='${receiptID}'`))
  const evaluated=sql(`SELECT evaluated_at::text FROM candidate_session_results WHERE session_id='${fixtures.session_id}'`)
  // Different delivery IDs exercise grader result idempotency in addition to ledger deduplication.
  const deliveryIds=Array.from({length:8},()=>randomUUID());for(const delivery of deliveryIds)publish('assessment_submissions',delivery,outbox)
  await wait(()=>deliveryIds.every(id=>state(id).startsWith('SUCCEEDED|1|')),'eight repeat grading deliveries')
  expect(sql(`SELECT evaluated_at::text FROM candidate_session_results WHERE session_id='${fixtures.session_id}'`)===evaluated,'Redelivery changed effective result timestamp')
  const receipt=await apiRequest(path+'/receipt',token);expect(JSON.stringify(receipt.data)===JSON.stringify(submitted.data),'Worker recovery changed candidate receipt')
  passed('Repeated grading jobs preserve one effective frozen result, original evaluation time and submission-only candidate receipt')
  const changed={...body,exam_title:'Mismatched payload'};publish('notification_events',id,changed)
  await delay(500);expect((await stats()).data.accepted===accepted+2,'Conflicting job identity delivered another email')
  await wait(async()=>{const h=(await json(workers.notification_url+'/healthz')).data;if(h.dead_letter_messages>=3&&h.alerts.includes('DEAD_LETTERS_PRESENT')){snapshots.final=h;return true}},'dead-letter alert')
  const metrics=await fetch(workers.notification_url+'/metrics').then(r=>r.text());expect(metrics.includes('worker_dead_letters')&&!metrics.includes('candidate@')&&!metrics.includes('body_hash'),'Health metrics leaked job details')
  passed('Identity/payload mismatch is quarantined; health, queue-age and dead-letter metrics expose no email contents or grading details')
  const result={passed:checks.length,checks,snapshots,scope:'Isolated real PostgreSQL, RabbitMQ and both production worker binaries; local SMTP sink only',profile:{max_attempts:3,processing_timeout:'1s',retry_delays:['2s','3s','4s']},limitation:'SMTP acceptance before database commit can resend after a crash; no external mail, result publication or deployment'}
  writeFileSync(join(review.directory,'worker-recovery-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
 }finally{if(brokerStopped)docker('start',broker);await mode('accept').catch(()=>{})}
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1})
