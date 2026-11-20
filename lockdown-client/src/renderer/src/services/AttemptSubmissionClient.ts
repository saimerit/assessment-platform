export interface SubmissionReceipt {
  submission_id: string
  version: number
  session_id?: string
  instance_id?: string
  checkpoint_revision: number
  submitted_at: string
  finalized_at: string
  timer_expires_at: string
  reason: 'MANUAL' | 'DEADLINE' | 'RECOVERED'
  answered_count: number
  question_count: number
}
export interface SubmissionView { status: 'idle' | 'syncing' | 'submitting' | 'pending' | 'received' | 'error'; message: string }
interface Transport { request(path: string, options?: RequestInit): Promise<Response> }
interface Checkpoints { synchronize(): Promise<number>; freeze(): Promise<void>; readonly revision: number; clear(): Promise<void> }
export function assertReceipt(value: SubmissionReceipt): void {
  if (!value || !/^[a-f0-9-]{36}$/i.test(value.submission_id) || value.version !== 1 ||
    !Number.isSafeInteger(value.checkpoint_revision) || value.checkpoint_revision < 0 ||
    !Number.isInteger(value.answered_count) || !Number.isInteger(value.question_count) || value.answered_count < 0 || value.answered_count > value.question_count ||
    !['submitted_at', 'finalized_at', 'timer_expires_at'].every(key => Number.isFinite(Date.parse(value[key]))) ||
    !['MANUAL', 'DEADLINE', 'RECOVERED'].includes(value.reason)) throw new Error('The server returned an invalid submission receipt.')
}
export async function fetchSubmissionReceipt(transport: Transport, path: string, signal?: AbortSignal): Promise<SubmissionReceipt | null> {
  const response = await transport.request(path + '/receipt', { signal })
  const data = await response.json()
  if (response.status === 404 && data.code === 'NO_RECEIPT') return null
  if (!response.ok) throw new Error(data.error || 'Unable to retrieve your submission receipt.')
  assertReceipt(data); return data
}

// A retry first retrieves the durable receipt. Unknown response delivery never
// clears a draft or claims completion; the server deduplicates finalization.
export class AttemptSubmissionClient {
  private running: Promise<SubmissionReceipt | null> | null = null
  private deadline = false
  private disposed = false
  private abort = new AbortController()
  private requested = false
  constructor(private readonly transport: Transport, private readonly path: string, private readonly checkpoint: Checkpoints,
    private readonly changed: (view: SubmissionView) => void) {}
  finalize(deadline = false): Promise<SubmissionReceipt | null> {
    this.deadline ||= deadline
    if (this.deadline) void this.checkpoint.freeze()
    if (this.running) return this.running
    if (this.disposed) return Promise.resolve(null)
    const run = this.perform(); this.running = run
    return run.finally(() => { if (this.running === run) this.running = null })
  }
  private emit(status: SubmissionView['status'], message: string): void { if (!this.disposed) this.changed({ status, message }) }
  private async accept(receipt: SubmissionReceipt): Promise<SubmissionReceipt> {
    assertReceipt(receipt); await this.checkpoint.clear().catch(() => {})
    this.emit('received', 'Your responses are saved and your receipt is available.'); return receipt
  }
  private async perform(): Promise<SubmissionReceipt | null> {
    try {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)])
      const existing = await fetchSubmissionReceipt(this.transport, this.path, signal)
      if (this.disposed) return null
      if (existing) return await this.accept(existing)
      this.emit('syncing', this.deadline ? 'Time has ended. Finalizing your server-saved responses…' : 'Saving your latest responses…')
      const revision = this.deadline ? this.checkpoint.revision : await this.checkpoint.synchronize()
      if (this.disposed) return null
      await this.checkpoint.freeze()
      this.requested = true; this.emit('submitting', 'Confirming your submission…')
      const response = await this.transport.request(this.path + '/submit', { method: 'POST', body: JSON.stringify({ checkpoint_revision: revision }), signal })
      const data = await response.json()
      if (this.disposed) return null
      if (!response.ok) throw new Error(data.error || 'Submission confirmation is unavailable. Retry to check your receipt.')
      return await this.accept(data)
    } catch (error) {
      if (this.disposed) return null
      this.emit(this.requested || this.deadline ? 'pending' : 'error', this.deadline
        ? 'Time has ended. Your server-saved responses will be finalized. Reconnect to retrieve the receipt.'
        : this.requested ? 'Awaiting confirmation. Your answers are retained. Retry to retrieve the receipt.'
          : error instanceof Error ? error.message : 'Unable to submit. Your answers are retained.')
      return null
    }
  }
  dispose(): void { this.disposed = true; this.abort.abort() }
}
