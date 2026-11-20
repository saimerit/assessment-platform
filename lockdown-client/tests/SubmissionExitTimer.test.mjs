import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const source = await readFile(new URL('../src/main/SubmissionExitTimer.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { SubmissionExitTimer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
function fixture() {
  let now = 0, closed = 0, nextId = 0
  const jobs = new Map()
  const timer = new SubmissionExitTimer(() => closed++, () => now,
    (callback, delay) => { const id = ++nextId; jobs.set(id, { callback, due: now + delay }); return id }, id => jobs.delete(id))
  return { timer, closed: () => closed, advance(ms) { now += ms; for (const [id, job] of jobs) { if (job.due <= now) { jobs.delete(id); job.callback() } } } }
}
test('native completion closes at one minute without waiting for grading or renderer activity', () => {
  const f = fixture(); assert.equal(f.timer.start('receipt-a'), 60_000)
  f.advance(59_999); assert.equal(f.closed(), 0)
  f.advance(1); assert.equal(f.closed(), 1)
})
test('duplicate completion cannot extend the existing close deadline', () => {
  const f = fixture(); f.timer.start('receipt-a'); f.advance(30_000)
  assert.equal(f.timer.start('receipt-a'), 30_000)
  f.advance(30_000); assert.equal(f.closed(), 1)
})
test('switching attempt cancels the old deadline before scheduling another receipt', () => {
  const f = fixture(); f.timer.start('receipt-a'); f.advance(30_000); f.timer.cancel()
  f.advance(30_000); assert.equal(f.closed(), 0)
  f.timer.start('receipt-b'); f.advance(60_000); assert.equal(f.closed(), 1)
})
