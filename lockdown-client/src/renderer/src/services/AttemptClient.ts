interface AttemptCredentials {
  attempt_token: string
  expires_at: string
  server_time: string
  unlocked: boolean
}

export interface CandidateAccount { id: string; role: string; email: string }

// A single in-memory credential owner serves exam requests and native telemetry.
export class AttemptClient {
  private accountToken = ''
  private invitationToken = ''
  private token = ''
  private expiresAt = 0
  private clockOffset = 0
  private generation = 0
  private renewal: Promise<void> | null = null
  private unlocked = false

  constructor(
    private readonly apiBase: string,
    private readonly onToken: (token: string) => Promise<void>,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)
  ) {}

  get signedIn(): boolean { return this.accountToken !== '' }
  get isUnlocked(): boolean { return this.unlocked }

  async signIn(email: string, password: string): Promise<CandidateAccount> {
    const generation = this.generation
    const response = await this.fetcher(`${this.apiBase}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.token) throw new Error(data?.error || 'Candidate sign-in failed.')
    if (data.user?.role !== 'CANDIDATE') throw new Error('Sign in with your candidate account to take this assessment.')
    if (generation !== this.generation) throw new Error('Candidate sign-in was cancelled.')
    this.accountToken = data.token
    return data.user as CandidateAccount
  }

  async assignedAssessments(): Promise<unknown> {
    const response = await this.fetcher(`${this.apiBase}/candidate/assessments`, { headers: { Authorization: `Bearer ${this.accountToken}` } })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error || 'Unable to load assigned assessments.')
    return data?.assessments ?? []
  }

  async reset(signOut = false): Promise<void> {
    this.generation += 1
    this.invitationToken = ''
    this.token = ''
    this.expiresAt = 0
    this.renewal = null
    this.unlocked = false
    if (signOut) this.accountToken = ''
    await this.onToken('')
  }

  async authorize(invitationToken: string): Promise<void> {
    await this.reset()
    this.invitationToken = invitationToken
    await this.refresh(true)
  }

  async refresh(force = false): Promise<void> {
    if (!this.invitationToken || !this.accountToken) throw new Error('Sign in with the candidate account assigned to this invitation.')
    if (!force && this.token && Date.now() + this.clockOffset < this.expiresAt - 60_000) return
    if (this.renewal) return this.renewal
    const generation = this.generation
    const renewal = (async () => {
      const response = await this.fetcher(`${this.apiBase}/exam/access`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.accountToken}` },
        body: JSON.stringify({ invitation_token: this.invitationToken })
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || 'Unable to renew assessment access. Check your connection and try again.')
      if (generation !== this.generation) throw new Error('The selected assessment has changed.')
      await this.acceptCredentials(data as AttemptCredentials)
    })()
    this.renewal = renewal
    try { await renewal } finally { if (this.renewal === renewal) this.renewal = null }
  }

  private async acceptCredentials(data: AttemptCredentials): Promise<void> {
    const expires = Date.parse(data.expires_at)
    const serverTime = Date.parse(data.server_time)
    if (!data.attempt_token || !Number.isFinite(expires) || !Number.isFinite(serverTime)) throw new Error('The server returned invalid assessment access.')
    // A renewal started before unlock can finish after it; preserve the newer
    // execution credential instead of replacing it with a check-in credential.
    if (this.unlocked && !data.unlocked) return
    this.unlocked = data.unlocked
    this.token = data.attempt_token
    this.expiresAt = expires
    this.clockOffset = serverTime - Date.now()
    await this.onToken(this.token)
  }

  async request(endpoint: string, options: RequestInit = {}): Promise<Response> {
    if (!endpoint.startsWith('/exam/sessions/') && !endpoint.startsWith('/assessments/')) throw new Error('Unsupported assessment endpoint.')
    await this.refresh()
    const generation = this.generation
    const send = () => {
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${this.token}`)
      headers.set('Content-Type', 'application/json')
      return this.fetcher(`${this.apiBase}${endpoint}`, { ...options, headers })
    }
    let response = await send()
    // Authentication middleware returns 401 before execution; one retry cannot
    // repeat an accepted write. Other write failures are never auto-retried.
    if (generation !== this.generation) throw new Error('The selected assessment has changed.')
    if (response.status === 401) { await this.refresh(true); response = await send() }
    if (generation !== this.generation) throw new Error('The selected assessment has changed.')
    if (response.ok && (endpoint.endsWith('/unlock') || endpoint.endsWith('/verify-passcode'))) {
      await this.acceptCredentials(await response.clone().json() as AttemptCredentials)
    }
    return response
  }
}
