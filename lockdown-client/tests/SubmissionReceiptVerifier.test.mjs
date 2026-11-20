import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const source=await readFile(new URL('../src/main/SubmissionReceiptVerifier.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
const {verifySubmissionReceipt}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const scope={kind:'session',id:'session-a',assessmentId:'assessment-a',token:'scoped-token',generation:1}
test('native release proof binds receipt request to the verified session token',async()=>{
 await verifySubmissionReceipt('https://exam.test/api',scope,'receipt-a',()=>1,async(url,options)=>{assert.equal(url,'https://exam.test/api/exam/sessions/session-a/receipt');assert.equal(options.headers.Authorization,'Bearer scoped-token');return new Response(JSON.stringify({submission_id:'receipt-a'}))})
})
test('native legacy proof uses the server-verified assessment identity',async()=>{
 await verifySubmissionReceipt('https://exam.test/api',{...scope,kind:'legacy'},'receipt-a',()=>1,async(url)=>{assert.equal(url,'https://exam.test/api/assessments/assessment-a/receipt');return new Response(JSON.stringify({submission_id:'receipt-a'}))})
})
test('unsubmitted, mismatched and stale proofs cannot release native controls',async()=>{
 for(const [status,id,generation] of [[404,undefined,1],[200,'another-receipt',1],[200,'receipt-a',2]])await assert.rejects(verifySubmissionReceipt('https://exam.test/api',scope,'receipt-a',()=>generation,async()=>new Response(JSON.stringify({submission_id:id}),{status})),/could not be verified/)
})
