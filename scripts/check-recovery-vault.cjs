// Uses real Electron safeStorage on this Windows user profile, in an isolated directory.
const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync, readdirSync, copyFileSync, utimesSync } = require('node:fs')
const { join } = require('node:path')
const Module = require('node:module')
const assert = require('node:assert/strict')
const ts = require('../lockdown-client/node_modules/typescript')
const root = join(__dirname, '..')
const review = JSON.parse(readFileSync(join(root, '.attempt-access-review/latest.json'), 'utf8'))
app.setPath('userData', join(review.directory, 'recovery-vault-test-profile'))
const file = join(root, 'lockdown-client/src/main/AttemptRecoveryVault.ts')
const loaded = new Module(file, module); loaded.filename = file; loaded.paths = module.paths
loaded._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
app.whenReady().then(async () => {
  try {
    assert(safeStorage.isEncryptionAvailable(), 'OS encryption unavailable')
    const { AttemptRecoveryVault } = loaded.exports, vault = new AttemptRecoveryVault()
    const scope = 'review/api/org/candidate/attempt', otherScope = 'review/api/org/other/attempt'
    const value = JSON.stringify({ answer: 'private recovery response', reviewed: true })
    await vault.clear(scope); await vault.clear(otherScope); await vault.write(scope, value)
    assert.equal(await vault.read(scope), value); assert.equal(await vault.read(otherScope), null)
    const directory = join(app.getPath('userData'), 'attempt-recovery')
    const original = readdirSync(directory).find(name => name.endsWith('.bin'))
    assert(!readFileSync(join(directory, original)).includes(Buffer.from('private recovery response')))
    assert.equal(await new AttemptRecoveryVault().read(scope), value)
    await vault.write(otherScope, 'different candidate')
    const other = readdirSync(directory).find(name => name.endsWith('.bin') && name !== original)
    copyFileSync(join(directory, original), join(directory, other))
    await assert.rejects(vault.read(otherScope), /does not belong/)
    await vault.clear(otherScope)
    const old = new Date(Date.now() - 73 * 3600000); utimesSync(join(directory, original), old, old)
    await vault.prune(); assert.equal(await vault.read(scope), null)
    await assert.rejects(vault.write(scope, 'x'.repeat(1024 * 1024 + 1)), /too large/)
    await Promise.all([vault.write(scope, 'first'), vault.write(scope, 'last')]); assert.equal(await vault.read(scope), 'last')
    await vault.clear(scope); assert.equal(await vault.read(scope), null)
    const result = { passed: 8, platform: process.platform, encryption: 'Electron safeStorage / Windows DPAPI', tests: ['encrypted roundtrip', 'no plaintext response', 'new vault restores', 'candidate scope separation', 'copied file rejected', '72-hour cleanup', 'size limit', 'serialized writes and clear'] }
    writeFileSync(join(review.directory, 'recovery-vault-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
