export interface CheckpointAnswer {
  question_id: string
  selected_option_ids: string[]
  typed_response: string | null
  reviewed: boolean
}
export interface CheckpointNavigation { question_id: string | null; active_view: 'home' | 'question' }
export interface AttemptCheckpoint {
  revision: number
  answers: CheckpointAnswer[]
  navigation: CheckpointNavigation
  saved_at: string | null
  started_at: string
  timer_expires_at: string
  server_time: string
}
interface SaveBatch { update_id: string; base_revision: number; answers: CheckpointAnswer[]; navigation?: CheckpointNavigation }
interface RecoveryBuffer { version: 1; base: AttemptCheckpoint; pending: Record<string, CheckpointAnswer>; navigation: CheckpointNavigation; navigationDirty: boolean; flight: SaveBatch | null }
export interface CheckpointView {
  answers: Record<string, CheckpointAnswer>
  navigation: CheckpointNavigation
  status: 'saved' | 'saving' | 'offline' | 'syncing' | 'error' | 'conflict'
  message: string
  localWarning: string
  savedAt: string | null
  recovered: boolean
  conflicts: string[]
  serverAnswers: Record<string, CheckpointAnswer>
}
interface RecoveryStorage { read(): Promise<string | null>; write(value: string): Promise<void>; clear(): Promise<void> }
interface CheckpointTransport { request(path: string, options?: RequestInit): Promise<Response> }
const canonical = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  : Array.isArray(value) ? value.map(canonical) : value
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const mapAnswers = (state: AttemptCheckpoint): Record<string, CheckpointAnswer> => Object.fromEntries(state.answers.map(answer => [answer.question_id, answer]))

// One owner serializes network saves and the encrypted recovery journal. A
// persistent flight ID survives crashes/ambiguous responses and deduplicates retries.
export class AttemptCheckpointClient {
  private base!: AttemptCheckpoint
  private pending: Record<string, CheckpointAnswer> = {}
  private navigation!: CheckpointNavigation
  private navigationDirty = false
  private flight: SaveBatch | null = null
  private running: Promise<void> | null = null
  private persistence: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private frozen = false
  private requestAbort: AbortController | null = null
  private status: CheckpointView['status'] = 'saved'
  private message = ''
  private localWarning = ''
  private recovered = false
  private conflicts: string[] = []

  constructor(private readonly transport: CheckpointTransport, private readonly path: string,
    private readonly storage: RecoveryStorage, private readonly changed: (view: CheckpointView) => void,
    private readonly knownQuestions: ReadonlySet<string>) {}

  private assertAnswer(answer: CheckpointAnswer): void {
    if (!answer || !this.knownQuestions.has(answer.question_id) || !Array.isArray(answer.selected_option_ids) ||
      answer.selected_option_ids.some(id => typeof id !== 'string') || new Set(answer.selected_option_ids).size !== answer.selected_option_ids.length ||
      !(answer.typed_response === null || typeof answer.typed_response === 'string') || typeof answer.reviewed !== 'boolean') throw new Error('Invalid recovery response for this paper.')
  }
  private assertNavigation(navigation: CheckpointNavigation): void {
    if (!navigation || !['home', 'question'].includes(navigation.active_view) ||
      !(navigation.question_id === null || this.knownQuestions.has(navigation.question_id)) ||
      (navigation.active_view === 'question' && !navigation.question_id)) throw new Error('Invalid saved navigation state.')
  }
  private assertState(state: AttemptCheckpoint): void {
    if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.answers) ||
      !Number.isFinite(Date.parse(state.timer_expires_at)) || !Number.isFinite(Date.parse(state.started_at)) ||
      !Number.isFinite(Date.parse(state.server_time)) || (state.saved_at !== null && !Number.isFinite(Date.parse(state.saved_at))) ||
      new Set(state.answers.map(answer => answer.question_id)).size !== state.answers.length) throw new Error('Invalid saved assessment state.')
    this.assertNavigation(state.navigation)
    state.answers.forEach(answer => this.assertAnswer(answer))
  }

  async open(): Promise<void> {
    this.requestAbort = new AbortController()
    const response = await this.transport.request(this.path, { signal: AbortSignal.any([this.requestAbort.signal, AbortSignal.timeout(10_000)]) })
    const server = await response.json() as AttemptCheckpoint & { error?: string }
    if (this.disposed) return
    if (!response.ok) throw new Error(server.error || 'Unable to restore saved answers.')
    this.assertState(server)
    this.base = server
    this.navigation = server.navigation
    try {
      const encoded = await this.storage.read()
      if (this.disposed) return
      if (encoded) {
        const cached = JSON.parse(encoded) as RecoveryBuffer
        if (cached.version !== 1) throw new Error('Unsupported recovery buffer.')
        this.assertState(cached.base)
        if (cached.base.started_at !== server.started_at || cached.base.timer_expires_at !== server.timer_expires_at) throw new Error('Recovery buffer belongs to a different attempt lifecycle.')
        this.assertNavigation(cached.navigation)
        if (!cached.pending || typeof cached.pending !== 'object' || Array.isArray(cached.pending) || typeof cached.navigationDirty !== 'boolean' || cached.base.revision > server.revision) throw new Error('Invalid recovery journal.')
        for (const [id, answer] of Object.entries(cached.pending)) {
          this.assertAnswer(answer)
          if (id !== answer.question_id) throw new Error('Invalid local recovery response.')
        }
        if (cached.flight) {
          const flight = cached.flight
          if (!/^[a-f0-9-]{36}$/i.test(flight.update_id) || flight.base_revision !== cached.base.revision || !Array.isArray(flight.answers) || flight.answers.length > 100 || new Set(flight.answers.map(answer => answer.question_id)).size !== flight.answers.length) throw new Error('Invalid recovery save batch.')
          flight.answers.forEach(answer => { this.assertAnswer(answer); if (!cached.pending[answer.question_id]) throw new Error('Incomplete recovery save batch.') })
          if (flight.navigation) this.assertNavigation(flight.navigation)
        }
        this.pending = cached.pending
        this.navigation = cached.navigation
        this.navigationDirty = cached.navigationDirty
        this.flight = cached.flight
        this.recovered = !!this.flight || Object.keys(this.pending).length > 0 || this.navigationDirty
        if (this.flight) this.base = cached.base
        else this.reconcile(cached.base, server)
      }
    } catch (error) { this.localWarning = error instanceof Error ? error.message : 'Protected local recovery is unavailable.' }
    if (this.disposed) return
    this.status = this.hasPending() ? 'syncing' : 'saved'
    this.emit()
    await this.persist()
    if (this.hasPending() && !this.conflicts.length) void this.flush()
  }

  private hasPending(): boolean { return !!this.flight || !!Object.keys(this.pending).length || this.navigationDirty }
  private emit(): void {
    if (this.disposed) return
    this.changed({ answers: { ...mapAnswers(this.base), ...this.pending }, navigation: this.navigation,
      status: this.conflicts.length ? 'conflict' : this.status, message: this.message, localWarning: this.localWarning,
      savedAt: this.base.saved_at, recovered: this.recovered, conflicts: [...this.conflicts], serverAnswers: mapAnswers(this.base) })
  }
  private persist(): Promise<void> {
    const encoded = JSON.stringify({ version: 1, base: this.base, pending: this.pending, navigation: this.navigation,
      navigationDirty: this.navigationDirty, flight: this.flight } satisfies RecoveryBuffer)
    this.persistence = this.persistence.catch(() => {}).then(() => this.storage.write(encoded)).catch(error => {
      this.localWarning = error instanceof Error ? error.message : 'Protected local recovery is unavailable.'
      this.emit()
    })
    return this.persistence
  }

  change(answer: CheckpointAnswer): void {
    if (this.disposed || this.frozen || !this.knownQuestions.has(answer.question_id)) return
    this.assertAnswer(answer)
    this.pending[answer.question_id] = { ...answer, selected_option_ids: [...answer.selected_option_ids].sort() }
    this.status = 'saving'; this.message = ''
    this.emit(); void this.persist(); this.schedule()
  }
  navigate(navigation: CheckpointNavigation): void {
    if (this.disposed || this.frozen) return
    this.assertNavigation(navigation)
    if (equal(navigation, this.navigation)) return
    this.navigation = navigation; this.navigationDirty = true
    this.status = 'saving'
    this.emit(); void this.persist(); this.schedule()
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, 500)
  }

  private reconcile(previous: AttemptCheckpoint, server: AttemptCheckpoint): void {
    const before = mapAnswers(previous), remote = mapAnswers(server)
    this.conflicts = []
    for (const [id, local] of Object.entries(this.pending)) {
      if (equal(local, remote[id])) delete this.pending[id]
      else if (!equal(before[id], remote[id])) this.conflicts.push(id)
    }
    this.base = server
    if (!this.navigationDirty) this.navigation = server.navigation
    if (this.conflicts.length) this.message = 'Answers changed in another session. Choose which responses to keep before saving.'
  }

  flush(): Promise<void> {
    if (this.running) return this.running
    if (this.disposed || this.frozen || this.conflicts.length || !this.hasPending()) return Promise.resolve()
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const run = this.savePending()
    this.running = run
    return run.finally(() => { if (this.running === run) this.running = null })
  }
  private async savePending(): Promise<void> {
    try {
      this.status = this.status === 'offline' ? 'syncing' : 'saving'; this.emit()
      while (!this.disposed && !this.frozen && this.hasPending() && !this.conflicts.length) {
        if (!this.flight) {
          const answers: CheckpointAnswer[] = []
          let bytes = 0
          for (const answer of Object.values(this.pending)) {
            const size = new TextEncoder().encode(JSON.stringify(answer)).byteLength + 1
            if (answers.length && (answers.length >= 100 || bytes + size > 512 * 1024)) break
            answers.push(structuredClone(answer)); bytes += size
          }
          this.flight = { update_id: crypto.randomUUID(), base_revision: this.base.revision, answers,
            ...(this.navigationDirty ? { navigation: { ...this.navigation } } : {}) }
        }
        await this.persist()
        if (this.disposed || this.frozen) return
        const flight = this.flight
        this.requestAbort = new AbortController()
        const response = await this.transport.request(this.path, { method: 'PUT', body: JSON.stringify(flight), signal: AbortSignal.any([this.requestAbort.signal, AbortSignal.timeout(10_000)]) })
        if (this.disposed || this.frozen) return
        const data = await response.json() as AttemptCheckpoint & { error?: string; checkpoint?: AttemptCheckpoint }
        if (response.status === 409) {
          if (!data.checkpoint) throw new Error(data.error || 'Save conflict. Reconnect to review saved answers.')
          this.assertState(data.checkpoint)
          this.flight = null
          this.reconcile(this.base, data.checkpoint)
          await this.persist(); this.emit()
          continue
        }
        if (!response.ok) throw new Error(data.error || 'Answers could not reach the server.')
        this.assertState(data)
        const expected = { ...this.base, answers: Object.values({ ...mapAnswers(this.base), ...Object.fromEntries(flight.answers.map(answer => [answer.question_id, answer])) }) }
        for (const answer of flight.answers) if (equal(this.pending[answer.question_id], answer)) delete this.pending[answer.question_id]
        if (flight.navigation && equal(flight.navigation, this.navigation)) this.navigationDirty = false
        this.flight = null
        this.reconcile(expected, data)
        await this.persist()
        this.emit()
      }
      if (!this.conflicts.length) { this.status = 'saved'; this.message = ''; this.emit() }
    } catch (error) {
      if (this.disposed || this.frozen) return
      this.status = !navigator.onLine || error instanceof TypeError ? 'offline' : 'error'
      this.message = error instanceof Error ? error.message : 'Waiting to synchronize answers.'
      await this.persist(); this.emit()
    }
  }

  async synchronize(): Promise<number> {
    await this.flush()
    if (this.hasPending() || this.conflicts.length || this.status !== 'saved') throw new Error('Synchronize your answers before submitting.')
    return this.base.revision
  }
  get revision(): number { return this.base?.revision ?? 0 }
  async freeze(): Promise<void> {
    this.frozen = true; this.requestAbort?.abort(); if (this.timer) clearTimeout(this.timer)
    await this.persistence
  }
  resolveConflict(keep: 'server' | 'local'): void {
    if (keep === 'server') for (const id of this.conflicts) delete this.pending[id]
    this.conflicts = []; this.message = ''; this.status = this.hasPending() ? 'saving' : 'saved'
    this.emit(); void this.persist(); void this.flush()
  }
  async clear(): Promise<void> { await this.dispose(); await this.storage.clear() }
  dispose(): Promise<void> {
    this.disposed = true; this.requestAbort?.abort(); if (this.timer) clearTimeout(this.timer)
    // Every edit is already journaled. Await the queue before a new owner reads;
    // never enqueue a stale snapshot after a replacement controller has opened.
    return this.persistence
  }
}
