import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// Only draft responses/checkpoints are stored here. Account/attempt credentials
// and grading keys never enter the recovery file. Windows uses user-bound DPAPI.
export class AttemptRecoveryVault {
  private writes: Promise<void> = Promise.resolve()
  private directory = join(app.getPath('userData'), 'attempt-recovery')

  private path(scope: string): string {
    if (!scope) throw new Error('Verified assessment access is required for recovery storage.')
    return join(this.directory, createHash('sha256').update(scope).digest('hex') + '.bin')
  }

  private ensureEncryption(): void {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('Protected recovery storage is unavailable on this device. Your answers can still save to the server.')
    }
  }

  async read(scope: string): Promise<string | null> {
    this.ensureEncryption()
    await this.writes
    try {
      const path = this.path(scope)
      const info = await stat(path)
      if (Date.now() - info.mtimeMs > 72 * 60 * 60_000) { await unlink(path); return null }
      const envelope = JSON.parse(safeStorage.decryptString(await readFile(path))) as { scope: string; value: string }
      if (envelope.scope !== scope || typeof envelope.value !== 'string') throw new Error('Recovery file does not belong to this assessment.')
      return envelope.value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async write(scope: string, value: string): Promise<void> {
    this.ensureEncryption()
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) throw new Error('Recovery buffer is too large.')
    const path = this.path(scope)
    const encrypted = safeStorage.encryptString(JSON.stringify({ scope, value }))
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true })
      try {
        await writeFile(path + '.tmp', encrypted, { mode: 0o600 })
        await rename(path + '.tmp', path)
      } catch (error) {
        await unlink(path + '.tmp').catch(() => {})
        throw error
      }
    })
    this.writes = write
    await write
  }

  async clear(scope: string): Promise<void> {
    const path = this.path(scope)
    const clear = this.writes.catch(() => {}).then(() => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error }))
    this.writes = clear
    await clear
  }

  async prune(): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[])
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.bin(?:\.tmp)?$/.test(name)) continue
      const path = join(this.directory, name)
      const info = await stat(path).catch(() => null)
      if (info && Date.now() - info.mtimeMs > 72 * 60 * 60_000) await unlink(path).catch(() => {})
    }
  }
}
