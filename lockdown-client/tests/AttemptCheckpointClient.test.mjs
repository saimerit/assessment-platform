import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/renderer/src/services/AttemptCheckpointClient.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { AttemptCheckpointClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const answer = (question_id, text, reviewed = false) => ({ question_id, selected_option_ids: [], typed_response: text, reviewed })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function fixture() {
  let server = { revision: 0, answers: [], navigation: { question_id: null, active_view: 'home' }, saved_at: null,
    started_at: '2026-11-19T10:00:00Z', timer_expires_at: '2026-11-19T11:00:00Z', server_time: '2026-11-19T10:01:00Z' }
  const receipts = new Map(), saves = [], views = []
  let journal = null, offline = false, loseResponse = false, storageFailure = false, hold = null
  const storage = { read: async () => journal, write: async value => { if (storageFailure) throw new Error('Encryption unavailable'); journal = value }, clear: async () => { journal = null } }
  const transport = { request: async (_path, options = {}) => {
    if (offline) throw new TypeError('Failed to fetch')
    if (options.method !== 'PUT') return json(server)
    const batch = JSON.parse(options.body); saves.push(batch)
    if (hold) { const wait = hold; hold = null; await wait.promise }
    if (!receipts.has(batch.update_id)) {
      if (batch.base_revision !== server.revision) return json({ checkpoint: server }, 409)
      server = { ...server, revision: server.revision + 1, saved_at: '2026-11-19T10:02:00Z',
        answers: Object.values({ ...Object.fromEntries(server.answers.map(a => [a.question_id, a])), ...Object.fromEntries(batch.answers.map(a => [a.question_id, a])) }),
        navigation: batch.navigation ?? server.navigation }
      receipts.set(batch.update_id, true)
    }
    if (loseResponse) { loseResponse = false; throw new TypeError('Response lost after commit') }
    return json(server)
  } }
  return { storage, transport, views, saves, make: (known = new Set(['q1', 'q2'])) => new AttemptCheckpointClient(transport, '/checkpoint', storage, view => views.push(view), known),
    view: () => views.at(-1), server: () => server, journal: () => journal,
    offline: value => { offline = value }, lose: () => { loseResponse = true }, failStorage: () => { storageFailure = true }, hold: value => { hold = value },
    replace: value => { server = { ...server, ...value } }, setJournal: value => { journal = value } }
}

test('answers, blank clears, flags and navigation restore from the server; submission clears journal', async () => {
  const f = fixture(), client = f.make(); await client.open()
  client.change(answer('q1', 'response', true)); client.navigate({ question_id: 'q1', active_view: 'question' })
  assert.equal(f.view().status, 'saving'); assert.equal(await client.synchronize(), 1)
  await client.dispose(); const restarted = f.make(); await restarted.open()
  assert.equal(f.view().answers.q1.typed_response, 'response'); assert.equal(f.view().answers.q1.reviewed, true)
  assert.equal(f.view().navigation.question_id, 'q1')
  restarted.change(answer('q1', '', true)); await restarted.synchronize()
  assert.equal(f.server().answers[0].typed_response, '')
  await restarted.clear(); await restarted.dispose(); assert.equal(f.journal(), null)
})

test('offline edits survive restart and replay in version order without a false saved label', async () => {
  const f = fixture(), client = f.make(); await client.open(); f.offline(true)
  client.change(answer('q1', 'offline response', true)); await client.flush()
  assert.equal(f.view().status, 'offline'); await assert.rejects(client.synchronize(), /Synchronize/)
  await client.dispose(); f.offline(false); const restarted = f.make(); await restarted.open()
  assert.equal(f.view().recovered, true); await restarted.synchronize()
  assert.equal(f.server().answers[0].typed_response, 'offline response'); await restarted.dispose()
})

test('ambiguous accepted save is retried with the same journaled ID after restart', async () => {
  const f = fixture(), client = f.make(); await client.open(); f.lose()
  client.change(answer('q1', 'committed')); await client.flush(); assert.equal(f.server().revision, 1)
  const id = f.saves[0].update_id; await client.dispose()
  const restarted = f.make(); await restarted.open(); await restarted.synchronize()
  assert.equal(f.saves[1].update_id, id); assert.equal(f.server().revision, 1); await restarted.dispose()
})

test('rapid edits during an in-flight save send the latest value in a second revision', async () => {
  const f = fixture(), client = f.make(); await client.open(); const wait = deferred(); f.hold(wait)
  client.change(answer('q1', 'first')); const saving = client.flush()
  await new Promise(resolve => setImmediate(resolve)); client.change(answer('q1', 'latest'))
  wait.resolve(); await saving
  assert.equal(f.server().revision, 2); assert.equal(f.server().answers[0].typed_response, 'latest'); await client.dispose()
})

test('independent remote edits rebase safely; same-question conflict requires explicit resolution', async () => {
  const f = fixture(), client = f.make(); await client.open()
  f.replace({ revision: 1, answers: [answer('q2', 'other question')] })
  client.change(answer('q1', 'local')); await client.synchronize()
  assert.equal(f.server().answers.length, 2)
  f.replace({ revision: 3, answers: [answer('q1', 'newer server'), answer('q2', 'other question')] })
  client.change(answer('q1', 'my revision')); await client.flush()
  assert.equal(f.view().status, 'conflict'); await assert.rejects(client.synchronize(), /Synchronize/)
  client.resolveConflict('server'); await client.synchronize()
  assert.equal(f.view().answers.q1.typed_response, 'newer server')
  f.replace({ revision: 4, answers: [answer('q1', 'another remote'), answer('q2', 'other question')] })
  client.change(answer('q1', 'explicit local')); await client.flush(); client.resolveConflict('local'); await client.synchronize()
  assert.equal(f.server().answers.find(a => a.question_id === 'q1').typed_response, 'explicit local'); await client.dispose()
})

test('storage encryption failure is visible while server saving remains usable', async () => {
  const f = fixture(); f.failStorage(); const client = f.make(); await client.open()
  client.change(answer('q1', 'server only')); await client.synchronize()
  assert.match(f.view().localWarning, /Encryption unavailable/); assert.equal(f.view().status, 'saved'); await client.dispose()
})

test('corrupt pending data and foreign navigation are rejected without replay', async () => {
  const f = fixture(), client = f.make(); await client.open(); await client.dispose()
  const cached = JSON.parse(f.journal()); cached.pending = { q1: { question_id: 'q1', selected_option_ids: [], reviewed: true } }
  f.setJournal(JSON.stringify(cached)); const restarted = f.make(); await restarted.open()
  assert.match(f.view().localWarning, /Invalid recovery response/); assert.equal(f.saves.length, 0)
  assert.throws(() => restarted.navigate({ question_id: 'foreign', active_view: 'question' }), /Invalid saved navigation/)
  await restarted.dispose()
})

test('disposing during journal persistence aborts sending and leaves recovery for the next owner', async () => {
  const f = fixture(), client = f.make(); await client.open(); const wait = deferred(), original = f.storage.write
  f.storage.write = async value => { await wait.promise; await original(value) }
  client.change(answer('q1', 'pending')); const saving = client.flush(); const closing = client.dispose()
  wait.resolve(); await closing; await saving; assert.equal(f.saves.length, 0)
  f.storage.write = original; const restarted = f.make(); await restarted.open(); await restarted.synchronize()
  assert.equal(f.server().answers[0].typed_response, 'pending'); await restarted.dispose()
})

test('large reconnect backlog is split into bounded versioned batches', async () => {
  const f = fixture(), known = new Set(Array.from({length:100},(_,i)=>'question-'+i)), client=f.make(known)
  await client.open()
  for(const id of known) client.change(answer(id,'x'.repeat(16000)))
  await client.synchronize()
  assert(f.saves.length>1); assert.equal(f.server().answers.length,100)
  for(const batch of f.saves) assert(Buffer.byteLength(JSON.stringify(batch))<1024*1024)
  await client.dispose()
})
