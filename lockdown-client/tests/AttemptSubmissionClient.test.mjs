import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const source=await readFile(new URL('../src/renderer/src/services/AttemptSubmissionClient.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
const {AttemptSubmissionClient}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const json=(value,status=200)=>new Response(JSON.stringify(value),{status})
const receipt={submission_id:'6c457b54-d367-4d42-9df0-a1d8d4e56872',version:1,checkpoint_revision:3,submitted_at:'2026-11-19T12:00:00Z',finalized_at:'2026-11-19T12:00:00Z',timer_expires_at:'2026-11-19T13:00:00Z',reason:'MANUAL',answered_count:1,question_count:2}
function fixture(){
 let committed=null,lose=false,failSync=false,malformed=false,freeze=0,clears=0,syncs=0
 const requests=[],views=[]
 const checkpoint={revision:3,synchronize:async()=>{syncs++;if(failSync)throw new Error('Resolve answer conflicts first');return 3},freeze:async()=>{freeze++},clear:async()=>{clears++}}
 const transport={request:async(path,options={})=>{requests.push({path,options});if(path.endsWith('/receipt'))return committed?json(committed):json({code:'NO_RECEIPT'},404)
  assert(freeze>0,'manual submission must freeze edits before sending');committed=malformed?{...receipt,submission_id:'invalid'}:receipt
  if(lose){lose=false;throw new TypeError('Response lost after commit')}return json(committed,202)
 }}
 return {client:new AttemptSubmissionClient(transport,'/attempt',checkpoint,view=>views.push(view)),requests,views,clears:()=>clears,syncs:()=>syncs,freeze:()=>freeze,lose:()=>{lose=true},failSync:()=>{failSync=true},existing:value=>{committed=value},malformed:()=>{malformed=true}}
}
test('manual submit flushes/freezes once, uses accepted revision and clears only after receipt',async()=>{
 const f=fixture();const [a,b]=await Promise.all([f.client.finalize(),f.client.finalize()]);assert.equal(a.submission_id,b.submission_id)
 assert.equal(f.syncs(),1);assert.equal(f.requests.filter(r=>r.path.endsWith('/submit')).length,1);assert.equal(JSON.parse(f.requests.at(-1).options.body).checkpoint_revision,3);assert.equal(f.clears(),1)
})
test('lost submission response keeps draft; retry obtains the same durable receipt without another write',async()=>{
 const f=fixture();f.lose();assert.equal(await f.client.finalize(),null);assert.equal(f.clears(),0);assert.equal(f.views.at(-1).status,'pending')
 const restored=await f.client.finalize();assert.equal(restored.submission_id,receipt.submission_id);assert.equal(f.clears(),1);assert.equal(f.requests.filter(r=>r.path.endsWith('/submit')).length,1)
})
test('existing automatic/restarted receipt bypasses answer synchronization and submission',async()=>{
 const f=fixture();f.existing({...receipt,reason:'DEADLINE'});const received=await f.client.finalize();assert.equal(received.reason,'DEADLINE');assert.equal(f.syncs(),0);assert.equal(f.requests.length,1)
})
test('deadline freezes edits and finalizes accepted revision without uploading pending answers',async()=>{
 const f=fixture();f.failSync();const received=await f.client.finalize(true);assert(received);assert.equal(f.syncs(),0);assert(f.freeze()>0);assert.equal(f.clears(),1)
})
test('unresolved save errors prevent manual submit and retain editable recovery data',async()=>{
 const f=fixture();f.failSync();assert.equal(await f.client.finalize(),null);assert.equal(f.requests.filter(r=>r.path.endsWith('/submit')).length,0);assert.equal(f.clears(),0);assert.equal(f.freeze(),0);assert.equal(f.views.at(-1).status,'error')
})
test('malformed confirmation cannot clear recovery or claim successful submission',async()=>{
 const f=fixture();f.malformed();assert.equal(await f.client.finalize(),null);assert.equal(f.clears(),0);assert.equal(f.views.at(-1).status,'pending')
})
