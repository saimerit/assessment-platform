// Live isolated API/DB/broker checks. Every Docker target is validated as a review container.
const {readFileSync,writeFileSync}=require('node:fs')
const {join}=require('node:path')
const {execFileSync}=require('node:child_process')
const {randomUUID}=require('node:crypto')
const root=join(__dirname,'..'),review=JSON.parse(readFileSync(join(root,'.attempt-access-review/latest.json'),'utf8'))
const fixtures=JSON.parse(readFileSync(join(review.directory,'checkpoint-fixtures.json'),'utf8'))
if(!/^assessment-auth-review-[a-f0-9]{12}$/.test(review.network)||!/^assessment-auth-test-pg-[a-f0-9]{12}$/.test(review.postgres))throw new Error('Requires isolated review environment')
const broker=review.submission_broker,api=review.network+'-api',grader=review.network+'-submission-grader'
if(broker!==review.network+'-submission-rabbit')throw new Error('Unexpected test broker')
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim()
const sql=query=>docker('exec',review.postgres,'psql','-U','root','-d','assessment_attempt_auth_test','-At','-v','ON_ERROR_STOP=1','-c',query)
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),expect=(ok,message)=>{if(!ok)throw new Error(message)}
const base=review.gateway_url+'/api',checks=[]
async function request(path,token,body,method=body===undefined?'GET':'POST'){
 const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)})
 const data=await response.json();return {status:response.status,data}
}
async function waitAPI(){for(let i=0;i<60;i++){try{const r=await request('/system/client-version');if(r.status===200)return}catch{}await delay(200)}throw new Error('Review API failed to restart')}
async function enter(legacy,account){
 const invitation=legacy?fixtures.legacy_invitation:fixtures.event_invitation,path=legacy?'/assessments/'+fixtures.blueprint_id:'/exam/sessions/'+fixtures.session_id
 const access=await request('/exam/access',account,{invitation_token:invitation});expect(access.status===200,'Check-in failed')
 const unlock=await request(path+(legacy?'/verify-passcode':'/unlock'),access.data.attempt_token,{passcode:legacy?fixtures.legacy_code:fixtures.event_code});expect(unlock.status===200,'Unlock failed')
 const token=unlock.data.attempt_token,start=await request(path+'/start',token,{});expect(start.status===200,'Start failed')
 const paper=legacy?start.data:((await request(path+'/questions',token)).data)
 return {path,token,paper:paper.questions,start:start.data}
}
(async()=>{
 let stopped=false,changedPaper=null
 try{
  const login=await request('/auth/login','',{email:fixtures.candidate_a,password:fixtures.password});expect(login.status===200,'Synthetic login failed');const account=login.data.token
  const event=await enter(false,account),fib=event.paper.find(q=>q.question_type==='FIB'),mcq=event.paper.find(q=>q.question_type==='MCQ')
  const update={update_id:randomUUID(),base_revision:0,answers:[{question_id:fib.question_id,selected_option_ids:[],typed_response:'My conflict response',reviewed:true},{question_id:mcq.question_id,selected_option_ids:[mcq.options[0].id],typed_response:null,reviewed:false}]}
  expect((await request(event.path+'/checkpoint',event.token,update,'PUT')).status===200,'Live save failed')
  const duplicate=await request(event.path+'/checkpoint',event.token,update,'PUT');expect(duplicate.data.revision===1,'Duplicate advanced revision')
  checks.push('Live checkpoint and idempotent retry preserve the accepted revision')
  docker('stop',broker);stopped=true
  console.log('Review broker stopped; checking durable API finalization.')
  const first=await request(event.path+'/submit',event.token,{checkpoint_revision:1});expect(first.status===202&&first.data.submission_id,'Broker outage prevented durable receipt')
  expect(!('grading_status' in first.data)&&!('delivery_status' in first.data),'Candidate receipt exposed internal processing state')
  const id=first.data.submission_id;expect(sql(`SELECT count(*) FROM submission_outbox WHERE submission_id='${id}' AND delivered_at IS NULL`)==='1','Outbox was lost')
  const repeats=await Promise.all(Array.from({length:6},()=>request(event.path+'/submit',event.token,{checkpoint_revision:1})))
  expect(repeats.every(r=>r.status===200&&r.data.submission_id===id&&r.data.finalized_at===first.data.finalized_at),'Concurrent submit changed receipt')
  checks.push('Broker outage returns a durable receipt; six concurrent retries retain one submission/outbox identity')
  docker('restart',api);await waitAPI();const restored=await request(event.path+'/receipt',event.token);expect(restored.data.submission_id===id,'API restart lost receipt')
  checks.push('API starts while broker is unavailable and preserves receipt retrieval')
  // Change only synthetic content after first start. The event must retain its original paper and keys.
  changedPaper={fib:fib.question_id,mcq:mcq.question_id}
  sql(`UPDATE questions SET marks=99,statement='Changed after start' WHERE id IN ('${fib.question_id}','${mcq.question_id}'); UPDATE answer_vault.secure_answer_keys SET expected_text='changed after start' WHERE question_id='${fib.question_id}';`)
  const legacy=await enter(true,account),legacyFib=legacy.paper.find(q=>q.question_type==='FIB')
  const legacySave=await request(legacy.path+'/checkpoint',legacy.token,{update_id:randomUUID(),base_revision:0,answers:[{question_id:legacyFib.question_id,selected_option_ids:[],typed_response:'changed after start',reviewed:true}]},'PUT');expect(legacySave.status===200,'Legacy save failed')
  sql(`UPDATE candidate_assessment_instances SET timer_expires_at=clock_timestamp()+interval '2 seconds' WHERE id='${fixtures.instance_id}'`)
  // No client submission is sent. The API must finalize at the stored deadline.
  await delay(4000);const automatic=await request(legacy.path+'/receipt',legacy.token);expect(automatic.status===200&&automatic.data.reason==='DEADLINE'&&automatic.data.checkpoint_revision===1&&automatic.data.answered_count===1,'Disconnected deadline was not finalized')
  const late=await request(legacy.path+'/checkpoint',legacy.token,{update_id:randomUUID(),base_revision:1,client_time:'2000-01-01T00:00:00Z',answers:[{question_id:legacyFib.question_id,selected_option_ids:[],typed_response:'late change',reviewed:false}]},'PUT');expect(late.status===403,'Late backdated edit was accepted')
  checks.push('Disconnected legacy deadline finalizes the accepted snapshot; backdated late edits are rejected')
  docker('start',broker);stopped=false
  for(let i=0;i<30;i++){try{docker('exec','--user','rabbitmq',broker,'rabbitmq-diagnostics','-q','check_running');break}catch{await delay(400)}}
  // Section 1C verifies publisher recovery. Consumer reconnect belongs to 1D;
  // explicitly restart the review worker instead of claiming automatic recovery.
  try{docker('inspect',grader);docker('restart',grader)}catch{docker('run','-d','--name',grader,'--network',review.network,'-e',`GRADING_DATABASE_URL=postgres://assessment_grader:test-grader-password@${review.postgres}:5432/assessment_attempt_auth_test?sslmode=disable`,'-e',`RABBITMQ_URL=amqp://guest:guest@${broker}:5672/`,review.grader_image ?? ('assessment-auth-review-grader:'+review.suffix+'-1c'))}
  console.log('Review broker restored; awaiting confirmed dispatch and grading.')
  let complete=false
  for(let i=0;i<100;i++){const state=sql(`SELECT count(*) FROM attempt_submissions WHERE id IN ('${id}','${automatic.data.submission_id}') AND grading_status='GRADED'`);if(state==='2'){complete=true;break}await delay(500)}
  expect(complete,'Outbox did not reconnect and grade both submissions')
  expect(sql(`SELECT score_obtained::text||'/'||max_score::text FROM candidate_session_results WHERE session_id='${fixtures.session_id}'`)==='2.00/2.00','Authoring changes altered pinned event grade')
  const deliveries=sql(`SELECT count(*) FROM submission_outbox WHERE submission_id IN ('${id}','${automatic.data.submission_id}') AND delivered_at IS NOT NULL`);expect(deliveries==='2','Publisher confirmations not recorded')
  checks.push('Broker reconnect dispatches both durable jobs with confirms; worker uses original event content/marks/keys')
  const refreshed=await request(event.path+'/receipt',event.token);expect(JSON.stringify(refreshed.data)===JSON.stringify(first.data),'Candidate receipt changed after private grading')
  const listing=await request('/candidate/assessments',account);expect(listing.status===200&&listing.data.assessments.every(a=>!('score' in a)&&!('evaluated_at' in a)&&a.status!=='EVALUATED'),'Candidate portal exposed confidential results')
  checks.push('Candidate receipt stays unchanged after private grading; candidate listing hides confidential scores and grading state')
  // Restore shared synthetic authoring content for the UI checks; pinned versions remain intact.
  sql(`UPDATE questions SET marks=1,statement=CASE WHEN id='${fib.question_id}' THEN 'Describe an answer' ELSE 'Choose valid options' END WHERE id IN ('${fib.question_id}','${mcq.question_id}');UPDATE answer_vault.secure_answer_keys SET expected_text='My conflict response' WHERE question_id='${fib.question_id}';`)
  const results={passed:checks.length,checks,event_receipt:id,legacy_receipt:automatic.data.submission_id,scope:'Isolated review API/PostgreSQL/RabbitMQ and actual grading worker; no production deployment',limitation:'Review worker manually restarted after broker recovery; automatic consumer reconnect remains section 1D'}
  writeFileSync(join(review.directory,'submission-delivery-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
 }finally{if(stopped)docker('start',broker);if(changedPaper)sql(`UPDATE questions SET marks=1,statement=CASE WHEN id='${changedPaper.fib}' THEN 'Describe an answer' ELSE 'Choose valid options' END WHERE id IN ('${changedPaper.fib}','${changedPaper.mcq}');UPDATE answer_vault.secure_answer_keys SET expected_text='My conflict response' WHERE question_id='${changedPaper.fib}';`)}
})().catch(error=>{console.error(error.message);process.exitCode=1})
