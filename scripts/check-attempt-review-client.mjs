import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const requireClient = createRequire(new URL('../lockdown-client/package.json', import.meta.url))
const ts = requireClient('typescript')
const review = JSON.parse(await readFile(new URL('../.attempt-access-review/latest.json', import.meta.url), 'utf8'))
const fixtures = JSON.parse(await readFile(`${review.directory}/fixtures.json`, 'utf8'))
const source = await readFile(new URL('../lockdown-client/src/renderer/src/services/AttemptClient.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { AttemptClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
let exchanges = 0
const client = new AttemptClient(`${review.gateway_url}/api`, async () => {}, async (url, options) => {
  const response = await fetch(url, options)
  if (!url.endsWith('/exam/access') || !response.ok) return response
  exchanges++
  if (exchanges !== 1) return response
  // Fault-inject an expired credential into the client cache. Preserve the
  // advertised future expiry so the request reaches the real server, gets 401,
  // and exercises the actual client's automatic re-exchange/retry path.
  const data = await response.json()
  const [header, encoded] = data.attempt_token.split('.')
  const claims = JSON.parse(Buffer.from(encoded, 'base64url'))
  claims.exp = Math.floor(Date.now() / 1000) - 5
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', 'review-only-secret-with-at-least-32-characters').update(`${header}.${payload}`).digest('base64url')
  data.attempt_token = `${header}.${payload}.${signature}`
  return new Response(JSON.stringify(data), { status: 200, headers: response.headers })
})
await client.signIn(fixtures.candidate_b, fixtures.password)
await client.authorize(fixtures.other_invitation)
const response = await client.request(`/exam/sessions/${fixtures.other_session_id}/questions`)
assert.equal(response.status, 200, await response.text())
assert.equal(exchanges, 2, 'the expired credential should trigger exactly one renewal')
console.log('PASS: live API rejected the expired credential; the actual desktop credential client renewed and retried successfully.')
