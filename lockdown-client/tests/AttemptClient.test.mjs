import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/renderer/src/services/AttemptClient.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { AttemptClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const credentials = (token = 'check-in', unlocked = false) => ({
  attempt_token: token, unlocked, expires_at: new Date(Date.now() + 900_000).toISOString(), server_time: new Date().toISOString()
})

test('default transport calls fetch with its browser global receiver', async (t) => {
  const originalFetch = globalThis.fetch
  const paths = []
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async function (url) {
    assert.equal(this, globalThis, 'native browser fetch requires its global receiver')
    paths.push(new URL(url).pathname)
    if (url.endsWith('/auth/login')) return json({ token: 'account', user: { role: 'CANDIDATE' } })
    if (url.endsWith('/exam/access')) return json(credentials())
    if (url.endsWith('/candidate/assessments')) return json({ assessments: [] })
    return json({})
  }
  const client = new AttemptClient('https://exam.test/api', async () => {})
  await client.signIn('candidate@example.com', 'password')
  await client.assignedAssessments()
  await client.authorize('invitation')
  await client.request('/exam/sessions/session/questions')
  assert.deepEqual(paths, ['/api/auth/login', '/api/candidate/assessments', '/api/exam/access', '/api/exam/sessions/session/questions'])
})

async function fixture(handler = () => json({})) {
  const calls = [], nativeTokens = []
  let exchanges = 0
  const client = new AttemptClient('https://exam.test/api', async (token) => { nativeTokens.push(token) }, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/auth/login')) return json({ token: 'account', user: { id: 'candidate', role: 'CANDIDATE' } })
    if (url.endsWith('/exam/access')) { exchanges += 1; return json(credentials(`access-${exchanges}`)) }
    return handler(url, options)
  })
  await client.signIn('candidate@example.com', 'password')
  await client.authorize('invitation')
  return { client, calls, nativeTokens, exchanges: () => exchanges }
}

test('exam and native telemetry use the scoped token, and unlock upgrades it', async () => {
  const f = await fixture((url) => url.endsWith('/unlock') ? json(credentials('unlocked', true)) : json({}))
  await f.client.request('/exam/sessions/session/unlock', { method: 'POST', body: '{}' })
  await f.client.request('/exam/sessions/session/start', { method: 'POST' })
  assert.equal(new Headers(f.calls.at(-1).options.headers).get('Authorization'), 'Bearer unlocked')
  assert.equal(f.nativeTokens.at(-1), 'unlocked')
  assert.equal(f.exchanges(), 1)
  assert.equal(new Headers(f.calls.find((c) => c.url.endsWith('/exam/access')).options.headers).get('Authorization'), 'Bearer account')
})

test('concurrent requests share a renewal and retry 401 once', async () => {
  let rejected = false
  const f = await fixture(() => { if (!rejected) { rejected = true; return json({}, 401) } return json({}) })
  await f.client.request('/exam/sessions/session/submit', { method: 'POST', body: '{}' })
  assert.equal(f.exchanges(), 2)
  const before = f.exchanges()
  await Promise.all([f.client.refresh(true), f.client.refresh(true), f.client.refresh(true)])
  assert.equal(f.exchanges(), before + 1)
})

test('failed writes and forbidden requests are not automatically replayed', async () => {
  for (const status of [403, 409, 500]) {
    const f = await fixture(() => json({}, status))
    const response = await f.client.request('/assessments/blueprint/submit', { method: 'POST', body: '{}' })
    assert.equal(response.status, status)
    assert.equal(f.calls.filter((c) => c.url.endsWith('/submit')).length, 1)
    assert.equal(f.exchanges(), 1)
  }
})

test('missing credentials and external endpoints never receive an exam token', async () => {
  const f = await fixture()
  await assert.rejects(f.client.request('https://other.test/submit'), /Unsupported/)
  await f.client.reset(true)
  await assert.rejects(f.client.request('/assessments/blueprint/start'), /Sign in/)
  assert.equal(f.nativeTokens.at(-1), '')
  assert.equal(f.client.signedIn, false)
})

test('staff accounts cannot enter the candidate flow', async () => {
  const client = new AttemptClient('/api', async () => {}, async () => json({ token: 'staff', user: { role: 'ORG_ADMIN' } }))
  await assert.rejects(client.signIn('admin@example.com', 'password'), /candidate account/)
  assert.equal(client.signedIn, false)
})

test('late renewal after sign-out cannot restore credentials', async () => {
  let resolveAccess
  const client = new AttemptClient('/api', async () => {}, async (url) => {
    if (url.endsWith('/auth/login')) return json({ token: 'account', user: { role: 'CANDIDATE' } })
    return new Promise((resolve) => { resolveAccess = resolve })
  })
  await client.signIn('candidate@example.com', 'password')
  const pending = client.authorize('invitation')
  await new Promise((resolve) => setImmediate(resolve))
  await client.reset(true)
  resolveAccess(json(credentials('late')))
  await assert.rejects(pending, /changed/)
  assert.equal(client.signedIn, false)
})

test('late check-in renewal cannot downgrade a newly unlocked token', async () => {
  let resolveRenewal, exchange = 0
  const tokens = []
  const client = new AttemptClient('/api', async (token) => { tokens.push(token) }, async (url) => {
    if (url.endsWith('/auth/login')) return json({ token: 'account', user: { role: 'CANDIDATE' } })
    if (url.endsWith('/exam/access')) {
      if (++exchange === 1) return json(credentials('check-in'))
      return new Promise((resolve) => { resolveRenewal = resolve })
    }
    return json(credentials('unlocked', true))
  })
  await client.signIn('candidate@example.com', 'password')
  await client.authorize('invitation')
  const renewal = client.refresh(true)
  await client.request('/exam/sessions/session/unlock', { method: 'POST' })
  resolveRenewal(json(credentials('stale-check-in')))
  await renewal
  assert.equal(tokens.at(-1), 'unlocked')
})
