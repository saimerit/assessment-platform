const CLOSE_DELAY_MS = 60_000

// Native ownership keeps the deadline running even when the renderer is hidden.
export class SubmissionExitTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private receiptId = ''
  private deadline = 0
  constructor(private readonly close: () => void, private readonly now = () => performance.now(),
    private readonly schedule = setTimeout, private readonly unschedule = clearTimeout) {}

  start(receiptId: string): number {
    if (this.timer !== null && this.receiptId === receiptId) return Math.max(0, this.deadline - this.now())
    this.cancel()
    this.receiptId = receiptId
    this.deadline = this.now() + CLOSE_DELAY_MS
    this.timer = this.schedule(() => { this.timer = null; this.close() }, CLOSE_DELAY_MS)
    return CLOSE_DELAY_MS
  }
  cancel(): void {
    if (this.timer !== null) this.unschedule(this.timer)
    this.timer = null
    this.receiptId = ''
  }
}
