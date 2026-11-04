import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { ExamRunner } from './components/ExamRunner'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8081/api'

interface IntakeField {
  key: string
  label: string
  type: 'text' | 'email' | 'tel'
  required: boolean
}

interface ExamInvitation {
  blueprint_id: string
  student_id: string
  session_id?: string
  assessment_id?: string
  paper_id?: string
  paper_code?: string
  paper_set_name?: string
  proctoring_mode?: 'ONLINE_PROCTORING' | 'OFFLINE_NORMAL' | 'OFFLINE_PROCTORING'
  duration_minutes?: number
  candidate_name: string
  email: string
  exam_title: string
  scheduled_start: string
  scheduled_end: string
  server_time: string
  window_status: 'NOT_OPEN' | 'OPEN' | 'IN_PROGRESS' | 'CLOSED'
  started_at?: string
  timer_expires_at?: string
  intake_fields?: IntakeField[]
  sections?: ExamSection[]
}

interface ExamSection {
  id: string
  name: string
  question_count: number
  total_marks: number
  question_types: Record<string, number>
  marks_by_type: Record<string, number>
}

interface CandidateAssessment {
  invitation_token: string
  blueprint_id: string
  exam_title: string
  scheduled_start: string
  scheduled_end: string
  status: string
}

type EntryMode = 'link' | 'login'
type Stage = 'entry' | 'loading' | 'error' | 'schedule' | 'intake' | 'terms' | 'diagnostics' | 'tutorial' | 'overview' | 'exam' | 'completed'

function extractInvitationToken(value: string): string {
  const input = value.trim()
  if (!input) return ''
  try {
    const url = new URL(input)
    if (url.protocol === 'lockdown:') return url.searchParams.get('token')?.trim() ?? ''
    const segments = url.pathname.split('/').filter(Boolean)
    return decodeURIComponent(segments[segments.length - 1] ?? '')
  } catch {
    return input
  }
}

function formatTimer(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const remaining = safe % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

const defaultFields: IntakeField[] = [
  { key: 'full_name', label: 'Full name', type: 'text', required: true },
  { key: 'email', label: 'Email address', type: 'email', required: true },
  { key: 'candidate_id', label: 'Candidate ID', type: 'text', required: false }
]

export default function App() {
  const [stage, setStage] = useState<Stage>('entry')
  const [entryMode, setEntryMode] = useState<EntryMode>('link')
  const [manualToken, setManualToken] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [candidateToken, setCandidateToken] = useState('')
  const [assignedExams, setAssignedExams] = useState<CandidateAssessment[]>([])
  const [invitation, setInvitation] = useState<ExamInvitation | null>(null)
  const [invitationToken, setInvitationToken] = useState('')
  const [form, setForm] = useState<Record<string, string>>({})
  const [passcode, setPasscode] = useState('')
  const [submittedInstanceId, setSubmittedInstanceId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [examTimerExpiresAt, setExamTimerExpiresAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [lockdownActive, setLockdownActive] = useState(false)
  const [exitModalOpen, setExitModalOpen] = useState(false)
  const [exitConfirmInput, setExitConfirmInput] = useState('')
  const [clock, setClock] = useState(new Date())
  const [online, setOnline] = useState(navigator.onLine)
  const [networkLatency, setNetworkLatency] = useState<number | null>(null)
  const [monitorCount, setMonitorCount] = useState<number | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [micReady, setMicReady] = useState(false)
  const [hardwareChecksBypassed, setHardwareChecksBypassed] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [battery, setBattery] = useState<number | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioFrameRef = useRef<number | null>(null)
  const serverClockOffsetRef = useRef(0)

  const syncClockFromServer = useCallback((serverTime: string) => {
    const timestamp = Date.parse(serverTime)
    if (!Number.isFinite(timestamp)) return
    serverClockOffsetRef.current = timestamp - Date.now()
    setClock(new Date(timestamp))
  }, [])

  const handleTimerStarted = useCallback((expiresAt: string, serverTime: string) => {
    setExamTimerExpiresAt(expiresAt)
    syncClockFromServer(serverTime)
  }, [syncClockFromServer])

  const loadInvitation = useCallback(async (token: string) => {
    setStage('loading')
    setError('')
    try {
      const normalizedToken = extractInvitationToken(token)
      if (!normalizedToken) throw new Error('Enter an invitation token or complete exam link.')
      const response = await fetch(`${API_BASE}/exg/${encodeURIComponent(normalizedToken)}`)
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || `Invitation API returned HTTP ${response.status}. Check that the Assessment API is running at ${API_BASE}.`)
      if (!data) throw new Error(`Invitation API at ${API_BASE} returned a non-JSON response.`)
      const exam = data as ExamInvitation
      syncClockFromServer(exam.server_time)
      setInvitationToken(normalizedToken)
      setInvitation(exam)
      setExamTimerExpiresAt(exam.timer_expires_at ?? null)
      const initialForm: Record<string, string> = { full_name: exam.candidate_name, email: exam.email }
      setForm(initialForm)
      setStage('schedule')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load this exam invitation.')
      setStage('entry')
    }
  }, [syncClockFromServer])

  useEffect(() => {
    let active = true
    window.lockdownAPI.getExamToken().then((token) => {
      if (active && token) void loadInvitation(token)
      else if (active) setStage('entry')
    })
    const unsubscribe = window.lockdownAPI.onExamToken((token) => void loadInvitation(token))
    const timer = window.setInterval(() => setClock(new Date(Date.now() + serverClockOffsetRef.current)), 1000)
    const onlineHandler = () => setOnline(true)
    const offlineHandler = () => setOnline(false)
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    const batteryNavigator = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener: (name: string, fn: () => void) => void }> }
    batteryNavigator.getBattery?.().then((deviceBattery) => {
      const update = () => setBattery(Math.round(deviceBattery.level * 100))
      update()
      deviceBattery.addEventListener('levelchange', update)
    }).catch(() => undefined)
    return () => {
      active = false
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (audioFrameRef.current !== null) cancelAnimationFrame(audioFrameRef.current)
      void audioContextRef.current?.close()
    }
  }, [loadInvitation])

  // Refresh the server's authoritative window status while the candidate is
  // on the schedule confirmation screen. The UI clock is display-only; all
  // actual entry attempts are checked again by the API.
  useEffect(() => {
    if (stage !== 'schedule' || !invitationToken) return
    let active = true
    const refreshSchedule = async () => {
      try {
        const response = await fetch(`${API_BASE}/exg/${encodeURIComponent(invitationToken)}`, { cache: 'no-store' })
        const data = await response.json().catch(() => null)
        if (!response.ok || !data || !active) return
        const updated = data as ExamInvitation
        syncClockFromServer(updated.server_time)
        setInvitation((current) => current ? { ...current, ...updated } : updated)
      } catch {
        // Keep the latest server-confirmed status visible and retry next poll.
      }
    }
    const timer = window.setInterval(() => void refreshSchedule(), 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [stage, invitationToken, syncClockFromServer])

  const handleCandidateLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoginBusy(true)
    setError('')
    try {
      const loginResponse = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      })
      const loginData = await loginResponse.json().catch(() => null)
      if (!loginResponse.ok || !loginData?.token) throw new Error(loginData?.error || 'Candidate sign-in failed.')

      const examsResponse = await fetch(`${API_BASE}/candidate/assessments`, {
        headers: { Authorization: `Bearer ${loginData.token}` }
      })
      const examsData = await examsResponse.json().catch(() => null)
      if (!examsResponse.ok) throw new Error(examsData?.error || 'Unable to load assigned assessments.')
      setCandidateToken(loginData.token)
      setAssignedExams(examsData?.assessments ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Candidate sign-in failed.')
    } finally {
      setLoginBusy(false)
    }
  }

  const openGateway = async () => {
    const token = extractInvitationToken(manualToken)
    if (!token) {
      setError('Enter an invitation token or exam link first.')
      return
    }
    try {
      await window.lockdownAPI.openExternal(`http://localhost:3000/exg/${encodeURIComponent(token)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to open the exam gateway.')
    }
  }

  const runDiagnostics = async () => {
    setError('')
    setStage('diagnostics')
    const isDev = window.location.hostname === 'localhost' || window.location.port !== ''
    const testHardwareInDev = import.meta.env.VITE_ENABLE_HARDWARE_CHECKS === 'true'
    setHardwareChecksBypassed(isDev && !testHardwareInDev)
    if (isDev && !testHardwareInDev) {
      setMonitorCount(1)
      setCameraReady(true)
      setMicReady(true)
      setAudioLevel(0)
      return
    }

    try {
      const monitors = await window.lockdownAPI.checkMonitors()
      setMonitorCount(monitors.count)
      if (!monitors.isSafe) throw new Error(`Multiple displays detected (${monitors.count}). Disconnect all additional displays.`)
      if (invitation?.proctoring_mode !== 'ONLINE_PROCTORING') {
        setCameraReady(true)
        setMicReady(true)
        setAudioLevel(0)
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone access is unavailable on this device.')
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setCameraReady(stream.getVideoTracks().some((track) => track.readyState === 'live'))
      const audioTrack = stream.getAudioTracks().find((track) => track.readyState === 'live')
      setMicReady(Boolean(audioTrack))
      if (audioTrack) {
        const context = new AudioContext()
        audioContextRef.current = context
        const analyser = context.createAnalyser()
        const source = context.createMediaStreamSource(new MediaStream([audioTrack]))
        source.connect(analyser)
        analyser.fftSize = 256
        const samples = new Uint8Array(analyser.frequencyBinCount)
        const measure = () => {
          analyser.getByteTimeDomainData(samples)
          let peak = 0
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128))
          setAudioLevel(Math.min(100, Math.round(peak * 2)))
          audioFrameRef.current = requestAnimationFrame(measure)
        }
        measure()
      }
      setStage('diagnostics')
    } catch (cause) {
      setCameraReady(false)
      setMicReady(false)
      setError(cause instanceof Error ? cause.message : 'Hardware check failed. Check camera and microphone permissions.')
    }
  }

  useEffect(() => {
    if (videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current
  }, [stage])

  useEffect(() => {
    if (!invitation) return
    let active = true
    const measure = async () => {
      const start = performance.now()
      try {
        const response = await fetch(`${API_BASE}/exg/${encodeURIComponent(invitationToken)}`, { cache: 'no-store' })
        if (!response.ok) throw new Error('Network check failed')
        if (active) setNetworkLatency(Math.round(performance.now() - start))
      } catch {
        if (active) setNetworkLatency(null)
      }
    }
    void measure()
    const timer = window.setInterval(() => void measure(), 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [invitation, invitationToken])

  const startExam = async () => {
    if (!invitation) return
    setBusy(true)
    setError('')
    try {
      const sessionId = invitation.session_id
      const endpoint = sessionId
        ? `${API_BASE}/exam/sessions/${encodeURIComponent(sessionId)}/unlock`
        : `${API_BASE}/assessments/${invitation.blueprint_id}/verify-passcode`
      const payload = sessionId
        ? { passcode, camera_ready: cameraReady, microphone_ready: micReady }
        : { passcode, student_id: invitation.student_id }
      const verify = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const verifyData = await verify.json().catch(() => null)
      if (!verify.ok) throw new Error(verifyData?.error || 'Invalid or expired invigilator passcode.')
      if (verifyData?.server_time) syncClockFromServer(verifyData.server_time)
      setExamTimerExpiresAt(null)
      setActiveSessionId(sessionId ?? null)
      await window.lockdownAPI.setExamContext({ blueprintId: invitation.blueprint_id, studentId: invitation.student_id })
      setStage('overview')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start assessment. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  const activateAssessment = useCallback(async () => {
    await window.lockdownAPI.engageLockdown()
    setLockdownActive(true)
  }, [])

  const fields = invitation?.intake_fields?.length ? invitation.intake_fields : defaultFields
  const handleClose = () => {
    if (lockdownActive && stage !== 'completed') {
      setExitModalOpen(true)
      return
    }
    if (lockdownActive) void window.lockdownAPI.quitApp()
    else window.lockdownAPI.closeApp()
  }
  const endTime = invitation ? Date.parse(invitation.scheduled_end) : Number.NaN
  const scheduledSeconds = Number.isFinite(endTime) ? Math.max(0, Math.floor((endTime - clock.getTime()) / 1000)) : null
  const startTime = invitation ? Date.parse(invitation.scheduled_start) : Number.NaN
  const secondsUntilStart = Number.isFinite(startTime) ? Math.max(0, Math.floor((startTime - clock.getTime()) / 1000)) : null
  const durationSeconds = invitation?.duration_minutes ? invitation.duration_minutes * 60 : null
  const windowTimerLabel = invitation?.window_status === 'IN_PROGRESS' ? 'Exam already started' : secondsUntilStart !== null && secondsUntilStart > 0 ? 'Window opens in' : scheduledSeconds !== null && scheduledSeconds > 0 ? 'Window closes in' : 'Window closed'
  const windowTimerSeconds = windowTimerLabel === 'Window opens in' ? secondsUntilStart : windowTimerLabel === 'Window closes in' ? scheduledSeconds : null
  const examTimerSeconds = examTimerExpiresAt ? Math.max(0, Math.ceil((Date.parse(examTimerExpiresAt) - clock.getTime()) / 1000)) : null
  const buttonStyle: CSSProperties = { width: '100%', padding: 12, background: '#596fc9', color: '#fff', border: 0, borderRadius: 9, cursor: 'pointer', fontWeight: 700, boxShadow: '0 5px 14px #596fc926' }
  const panelStyle: CSSProperties = { width: 'min(560px, 100%)', background: '#fff', border: '1px solid #e3e8f3', borderRadius: 18, padding: 26, boxSizing: 'border-box', textAlign: 'left', boxShadow: '0 24px 70px #293c6812' }
  const inputStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: 11, marginTop: 5, background: '#fbfcff', border: '1px solid #dfe5f1', color: '#26345c', borderRadius: 9 }

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#f7f8fc', color: '#253256', fontFamily: 'Inter, Segoe UI, Arial, sans-serif', userSelect: 'none' }}>
      <header style={{ height: 54, flexShrink: 0, padding: '0 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff', borderBottom: '1px solid #e5e9f2', fontSize: 12, boxShadow: '0 3px 14px #293c6808' }}>
        <strong style={{ letterSpacing: 1, color: '#445a9f' }}>✦ OA SECURE CLIENT</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, color: '#68748e' }}>
          <span style={{ color: online ? '#18a875' : '#e15d69' }}>● {online ? `Network ${networkLatency === null ? 'online' : `${networkLatency} ms`}` : 'Offline'}</span>
          {battery !== null && <span>Battery {battery}%</span>}
          {invitation && stage !== 'completed' && <span aria-live="off" title="Server-checked schedule window. Entry must begin within this slot." style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 7, padding: '6px 9px', background: '#f8fafc', border: '1px solid #e2e8f0', color: windowTimerSeconds === null ? '#be4056' : '#475569', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}><span>{windowTimerLabel}</span>{windowTimerSeconds !== null && <code style={{ background: 'transparent', color: 'inherit', padding: 0 }}>{formatTimer(windowTimerSeconds)}</code>}</span>}
          {(stage === 'exam' || invitation?.window_status === 'IN_PROGRESS') && examTimerSeconds !== null && <span aria-live="off" title="Candidate's separate exam-duration timer. It starts when the exam is entered." style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 7, padding: '6px 9px', background: '#eef2ff', border: '1px solid #dbe3ff', color: examTimerSeconds < 300 ? '#be4056' : '#40569f', fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap' }}><span>Exam timer</span><code style={{ background: 'transparent', color: 'inherit', padding: 0 }}>{formatTimer(examTimerSeconds)}</code></span>}
          <code style={{ display: 'inline-block', border: '1px solid #dbe3ef', borderRadius: 6, background: '#f1f5f9', color: '#334155', padding: '6px 8px', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{clock.toLocaleTimeString()}</code>
          <button onClick={handleClose} aria-label={lockdownActive ? 'Forfeit and exit assessment' : 'Close client'} title={lockdownActive ? 'Forfeit and exit assessment' : 'Close client'} style={{ color: '#c94d64', background: '#fff5f6', border: '1px solid #f3d3d9', borderRadius: 8, padding: '7px 11px', cursor: 'pointer' }}>✕ Close</button>
        </div>
      </header>
      <main style={{ flex: 1, overflow: 'auto', padding: stage === 'exam' ? 18 : 24, display: stage === 'exam' ? 'block' : 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at 12% 5%, #edf0ff 0, transparent 28%), radial-gradient(circle at 88% 95%, #eef5ff 0, transparent 30%), #f7f8fc' }}>
        {stage !== 'exam' && stage !== 'completed' && <section style={stage === 'overview' ? { ...panelStyle, width: 'min(1020px, 100%)', maxHeight: '100%', overflowY: 'auto' } : panelStyle}>
          {error && <div role="alert" style={{ background: '#fff0f1', color: '#b93651', border: '1px solid #f5d4da', padding: 11, borderRadius: 9, marginBottom: 16, fontSize: 13 }}>{error}</div>}
          {stage === 'entry' && <>
            <div style={{ textAlign: 'left', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}><span style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 12, background: '#10b981', color: '#fff', fontWeight: 900, fontSize: 18 }}>A</span><strong style={{ color: '#1e936d', letterSpacing: .2 }}>AssessPro</strong><span style={{ borderRadius: 999, padding: '4px 8px', background: '#dcfce7', color: '#16855f', fontSize: 10, fontWeight: 800 }}>Candidate</span></div>
              <p style={{ margin: 0, color: '#159c70', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 2 }}>Secure assessment access</p>
              <h1 style={{ margin: '6px 0 0', fontSize: 25, color: '#26345c' }}>Welcome back</h1>
              <p style={{ color: '#7a86a0', fontSize: 13 }}>Use your invitation link or candidate account to continue.</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 5, background: '#f0f2f9', borderRadius: 10, marginBottom: 18 }}>
              <button onClick={() => { setEntryMode('link'); setError('') }} style={{ ...buttonStyle, background: entryMode === 'link' ? '#596fc9' : 'transparent', color: entryMode === 'link' ? '#fff' : '#66728c', boxShadow: 'none' }}>Invitation Link</button>
              <button onClick={() => { setEntryMode('login'); setError('') }} style={{ ...buttonStyle, background: entryMode === 'login' ? '#596fc9' : 'transparent', color: entryMode === 'login' ? '#fff' : '#66728c', boxShadow: 'none' }}>Candidate Login</button>
            </div>
            {entryMode === 'link' && <div>
              <label style={{ display: 'block', color: '#6e7a94', fontSize: 13 }}>Invitation token or exam URL
                <input value={manualToken} onChange={(event) => setManualToken(event.target.value)} placeholder="Paste your invitation token or link" style={inputStyle} autoComplete="off" />
              </label>
              <button style={{ ...buttonStyle, marginTop: 14 }} disabled={busy || !manualToken.trim()} onClick={() => void loadInvitation(manualToken)}>{busy ? 'Loading…' : 'Load Assessment'}</button>
              <button style={{ ...buttonStyle, width: '100%', marginTop: 9 }} disabled={!manualToken.trim()} onClick={() => void openGateway()}>Open Gateway in Browser ↗</button>
              <p style={{ color: '#8994aa', textAlign: 'center', fontSize: 11, marginBottom: 0 }}>Use your invitation link or token from the assessment email.</p>
            </div>}
            {entryMode === 'login' && <div>
              {!candidateToken ? <form onSubmit={(event) => void handleCandidateLogin(event)}>
                <label style={{ display: 'block', color: '#6e7a94', fontSize: 13, marginBottom: 12 }}>Email<input type="email" required value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="candidate@example.com" style={inputStyle} autoComplete="username" /></label>
                <label style={{ display: 'block', color: '#6e7a94', fontSize: 13 }}>Password<input type="password" required value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} style={inputStyle} autoComplete="current-password" /></label>
                <button type="submit" style={{ ...buttonStyle, marginTop: 14 }} disabled={loginBusy}>{loginBusy ? 'Signing in…' : 'Sign In & View Exams'}</button>
              </form> : <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}><b style={{ fontSize: 13 }}>Assigned assessments</b><button onClick={() => { setCandidateToken(''); setAssignedExams([]); setLoginPassword('') }} style={{ ...buttonStyle, padding: '6px 9px', fontSize: 11 }}>Sign out</button></div>
                {assignedExams.length === 0 ? <p style={{ color: '#94a3b8', fontSize: 13 }}>No active assessments are assigned to this account.</p> : <div style={{ display: 'grid', gap: 9, maxHeight: 240, overflowY: 'auto' }}>
                  {assignedExams.map((exam) => <button key={exam.invitation_token} onClick={() => void loadInvitation(exam.invitation_token)} style={{ ...buttonStyle, textAlign: 'left', background: '#fff', color: '#33436c', border: '1px solid #e3e8f3', boxShadow: 'none' }}><b style={{ display: 'block' }}>{exam.exam_title}</b><span style={{ color: '#7b87a0', fontSize: 11 }}>Status: {exam.status} · {new Date(exam.scheduled_start).toLocaleString()}</span><span style={{ display: 'block', color: '#596fc9', fontSize: 11, marginTop: 5 }}>Review exam →</span></button>)}
                </div>}
              </div>}
            </div>}
          </>}
          {stage === 'loading' && <div><h2>Secure Exam Gateway</h2><p style={{ color: '#7a86a0' }}>Waiting for your personal exam link…</p></div>}
          {stage === 'error' && <div><h2>Unable to load invitation</h2><p style={{ color: '#7a86a0', fontSize: 13 }}>Check that the Assessment API is running and that this invitation link is valid.</p></div>}
          {stage === 'schedule' && invitation && <>
            <h2 style={{ marginTop: 0 }}>Confirm your assessment</h2>
            <p style={{ color: '#7a86a0', fontSize: 13 }}>Check the exam and its scheduled window before continuing. The server confirms whether entry is currently allowed.</p>
            <div style={{ display: 'grid', gap: 10, margin: '18px 0', padding: 16, border: '1px solid #e3e8f3', borderRadius: 12, background: '#fafbff' }}>
              <div><span style={{ color: '#8792a9', fontSize: 11 }}>Exam</span><b style={{ display: 'block', marginTop: 3, color: '#33436c', fontSize: 17 }}>{invitation.exam_title}</b></div>
              <div><span style={{ color: '#8792a9', fontSize: 11 }}>Candidate</span><b style={{ display: 'block', marginTop: 3, color: '#53617f', fontSize: 13 }}>{invitation.candidate_name} · {invitation.email}</b></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                <div><span style={{ color: '#8792a9', fontSize: 11 }}>Exam opens</span><b style={{ display: 'block', marginTop: 3, color: '#33436c', fontSize: 12 }}>{new Date(invitation.scheduled_start).toLocaleString()}</b></div>
                <div><span style={{ color: '#8792a9', fontSize: 11 }}>Exam closes</span><b style={{ display: 'block', marginTop: 3, color: '#33436c', fontSize: 12 }}>{new Date(invitation.scheduled_end).toLocaleString()}</b></div>
              </div>
              <div style={{ borderTop: '1px solid #e5e9f2', paddingTop: 12 }}><b style={{ display: 'block', marginBottom: 8, color: '#53617f', fontSize: 12 }}>Question paper pattern{invitation.paper_code ? ` · ${invitation.paper_code}` : ''}</b>{invitation.paper_id && <span style={{ display: 'block', marginBottom: 8, color: '#8792a9', fontSize: 10 }}>QP ID: {invitation.paper_id}</span>}{invitation.sections?.length ? <div style={{ display: 'grid', gap: 8 }}>{invitation.sections.map((section, index) => <div key={section.id || index} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: 10, border: '1px solid #e8ecf5', borderRadius: 9, background: '#fff' }}><div><b style={{ color: '#34446c', fontSize: 11 }}>{section.name}</b><span style={{ marginLeft: 8, color: '#8792a9', fontSize: 10 }}>{section.question_count} questions</span></div><div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{Object.entries(section.question_types ?? {}).map(([type, count]) => <span key={type} style={{ borderRadius: 999, background: '#f1f3fc', color: '#586bb1', padding: '4px 7px', fontSize: 9 }}>{type}: {count} · {section.marks_by_type?.[type] ?? 0} marks</span>)}<span style={{ color: '#6779c3', fontSize: 10, fontWeight: 700 }}>{section.total_marks} total</span></div></div>)}</div> : <p style={{ margin: 0, color: '#8792a9', fontSize: 11 }}>Paper pattern will be available after the event assigns a question paper.</p>}</div>
              <div style={{ borderTop: '1px solid #e5e9f2', paddingTop: 10 }}><span style={{ color: '#8792a9', fontSize: 11 }}>Server schedule check</span><b style={{ display: 'block', marginTop: 3, color: invitation.window_status === 'OPEN' || invitation.window_status === 'IN_PROGRESS' ? '#159c70' : invitation.window_status === 'CLOSED' ? '#d6576c' : '#bd842b', fontSize: 13 }}>{invitation.window_status === 'IN_PROGRESS' ? 'Attempt active — resume before your exam timer expires' : invitation.window_status === 'OPEN' ? 'Window open — you may continue' : invitation.window_status === 'CLOSED' ? 'Window closed — this exam can no longer be started' : 'Not open yet — waiting for the scheduled start'}</b><span style={{ display: 'block', marginTop: 3, color: '#8792a9', fontSize: 10 }}>Server time: {new Date(invitation.server_time).toLocaleString()}</span></div>
            </div>
            <p style={{ color: '#8994aa', fontSize: 11 }}>Entry is available only from the scheduled start time up to, but not including, the scheduled end time. The schedule is rechecked by the server when you start.</p>
            <button style={{ ...buttonStyle, opacity: invitation.window_status === 'OPEN' || invitation.window_status === 'IN_PROGRESS' ? 1 : .45, cursor: invitation.window_status === 'OPEN' || invitation.window_status === 'IN_PROGRESS' ? 'pointer' : 'not-allowed' }} disabled={invitation.window_status !== 'OPEN' && invitation.window_status !== 'IN_PROGRESS'} onClick={() => { setError(''); setStage('intake') }}>{invitation.window_status === 'NOT_OPEN' ? 'Waiting for exam window…' : invitation.window_status === 'CLOSED' ? 'Exam window closed' : invitation.window_status === 'IN_PROGRESS' ? 'Resume your exam' : 'Continue to candidate details'}</button>
          </>}
          {stage === 'intake' && invitation && <>
            <h2 style={{ marginTop: 0 }}>Candidate details</h2><p style={{ color: '#7a86a0', fontSize: 13 }}>{invitation.exam_title} · Please verify your details before continuing.</p>
            {fields.map((field) => <label key={field.key} style={{ display: 'block', margin: '12px 0', fontSize: 13 }}>{field.label}{field.required ? ' *' : ''}<input required={field.required} type={field.type} value={form[field.key] ?? ''} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} style={inputStyle} /></label>)}
            <button style={buttonStyle} onClick={() => { if (fields.some((field) => field.required && !form[field.key]?.trim())) { setError('Complete all required fields before continuing.'); return } setError(''); setStage('terms') }}>Continue to honor code</button>
          </>}
          {stage === 'terms' && <>
            <h2 style={{ marginTop: 0 }}>Honor code & examination terms</h2>
            <div style={{ background: '#f5f7fc', padding: 15, borderRadius: 9, color: '#53617f', fontSize: 13, lineHeight: 1.7, border: '1px solid #e8ecf5' }}>
              <p>1. I will not consult external materials, search engines, or secondary devices during this assessment.</p><p>2. I understand that camera, microphone, and background activity may be audited.</p><p>3. Switching away from the assessment or connecting another display may be reported to the invigilator.</p>
            </div>
            <label style={{ display: 'block', margin: '16px 0', fontSize: 13 }}>Invigilator passcode<input type="password" value={passcode} onChange={(event) => setPasscode(event.target.value)} style={inputStyle} autoComplete="off" /></label>
            <button style={buttonStyle} onClick={() => { void runDiagnostics() }}>I accept and agree · run hardware checks</button>
          </>}
          {stage === 'diagnostics' && <>
            <h2 style={{ marginTop: 0 }}>Hardware verification</h2>
            {invitation?.proctoring_mode === 'ONLINE_PROCTORING' && <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%', height: 190, objectFit: 'cover', background: '#000', borderRadius: 8, marginBottom: 12 }} />}
            <div style={{ display: 'grid', gap: 8, fontSize: 13, color: '#53617f' }}>
              <div>Display setup: <b style={{ color: monitorCount === 1 ? '#159c70' : '#c28526' }}>{monitorCount === 1 ? 'Single display verified' : `${monitorCount ?? 'Checking'} displays`}</b></div>
              {invitation?.proctoring_mode === 'ONLINE_PROCTORING' && <>{hardwareChecksBypassed && <p style={{ margin: 0, padding: 10, borderRadius: 8, background: '#fff8e8', color: '#986b1e', fontSize: 11 }}>Development mode skipped real camera and microphone access. Set VITE_ENABLE_HARDWARE_CHECKS=true to test connected devices.</p>}<div>Webcam: <b style={{ color: cameraReady ? '#159c70' : '#d6576c' }}>{hardwareChecksBypassed ? 'Skipped in development' : cameraReady ? 'Ready' : 'Unavailable'}</b></div><div>Microphone: <b style={{ color: micReady ? '#159c70' : '#d6576c' }}>{hardwareChecksBypassed ? 'Skipped in development' : micReady ? `Signal ${audioLevel}%` : 'Unavailable'}</b></div></>}
              {invitation?.proctoring_mode !== 'ONLINE_PROCTORING' && <div>Camera and microphone: Not required for this proctoring mode</div>}
            </div>
            <button style={{ ...buttonStyle, marginTop: 18 }} disabled={monitorCount !== 1 || (invitation?.proctoring_mode === 'ONLINE_PROCTORING' && (!cameraReady || !micReady))} onClick={() => { setError(''); setStage('tutorial') }}>Continue to tutorial</button>
          </>}
          {stage === 'tutorial' && <>
            <h2 style={{ marginTop: 0 }}>Exam interface walkthrough</h2>
            <ul style={{ color: '#596681', fontSize: 13, lineHeight: 1.9, paddingLeft: 20 }}><li>Select an option to save your response.</li><li>Review each question before final submission.</li><li>Your exam timer and section navigator will appear in the assessment.</li><li>The client enters kiosk mode only after you confirm the exam outline.</li></ul>
            <button style={buttonStyle} disabled={busy || !passcode} onClick={() => void startExam()}>{busy ? 'Verifying passcode…' : 'Verify passcode & review questions'}</button>
          </>}
          {stage === 'overview' && invitation && <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 18 }}><div><p style={{ margin: '0 0 5px', color: '#6679c8', fontSize: 11, fontWeight: 800, letterSpacing: 1.3, textTransform: 'uppercase' }}>Assessment outline</p><h1 style={{ margin: 0, color: '#27365f', fontSize: 23 }}>{invitation.exam_title}</h1><p style={{ margin: '7px 0 0', color: '#7a86a0', fontSize: 12 }}>Review the sections and question list before entering the exam.</p></div><span style={{ borderRadius: 999, background: '#eef0ff', color: '#5b6fbd', padding: '7px 11px', fontSize: 11, fontWeight: 700 }}>{invitation.proctoring_mode?.replaceAll('_', ' ') ?? 'Assessment'}</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 18 }}>
              {[
                { label: 'Paper ID', value: invitation.paper_code ?? invitation.paper_id ?? 'Assigned' },
                { label: 'Sections', value: invitation.sections?.length ?? 0 },
                { label: 'Questions', value: invitation.sections?.reduce((sum, section) => sum + section.question_count, 0) ?? 0 },
                { label: 'Total points', value: invitation.sections?.reduce((sum, section) => sum + section.total_marks, 0) ?? 0 },
                { label: 'Duration', value: `${invitation.duration_minutes ?? 60} min` },
              ].map((item) => <div key={item.label} style={{ padding: 12, border: '1px solid #e7eaf3', borderRadius: 11, background: '#fafbff' }}><span style={{ display: 'block', color: '#8792a9', fontSize: 10 }}>{item.label}</span><b style={{ display: 'block', marginTop: 3, color: '#33436c', fontSize: 16 }}>{item.value}</b></div>)}
            </div>
            <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
              {(invitation.sections ?? []).map((section, sectionIndex) => <section key={section.id || sectionIndex} style={{ overflow: 'hidden', border: '1px solid #e2e7f2', borderRadius: 12, background: '#fff' }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 15px', background: '#f1f3fc', borderBottom: '1px solid #e5e9f4' }}><div><p style={{ margin: 0, color: '#6477c5', fontSize: 9, fontWeight: 800, letterSpacing: 1 }}>SECTION {sectionIndex + 1}</p><h2 style={{ margin: '3px 0 0', color: '#34446c', fontSize: 14 }}>{section.name}</h2></div><span style={{ color: '#75819a', fontSize: 10 }}>{section.question_count} questions · {section.total_marks} marks</span></div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>{Object.entries(section.question_types ?? {}).map(([type, count]) => <span key={type} style={{ borderRadius: 999, background: '#f1f3fc', color: '#586bb1', padding: '6px 9px', fontSize: 10 }}>{type}: {count} questions · {section.marks_by_type?.[type] ?? 0} marks</span>)}</div></section>)}
              {(!invitation.sections || invitation.sections.length === 0) && <div style={{ padding: 18, border: '1px solid #e5e9f2', borderRadius: 11, color: '#7a86a0', fontSize: 12 }}>The question outline is not available for this legacy assessment. You can continue to the exam.</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, borderTop: '1px solid #e9ecf4', paddingTop: 15 }}><span style={{ color: '#8792a9', fontSize: 10 }}>The scheduled window controls when you may start. Your exam-duration timer begins only after you enter.</span><button style={{ ...buttonStyle, width: 'auto', minWidth: 230, padding: '12px 18px' }} onClick={() => { setError(''); setStage('exam') }}>Engage lockdown &amp; start exam →</button></div>
          </>}
        </section>}
        {stage === 'diagnostics' && <button onClick={() => void runDiagnostics()} style={{ position: 'fixed', bottom: 56, padding: '7px 12px', borderRadius: 8, color: '#64718b', background: '#fff', border: '1px solid #e1e6f0', fontSize: 12 }}>Run hardware checks</button>}
        {stage === 'exam' && invitation && <ExamRunner
          key={`${invitation.blueprint_id}:${invitation.student_id}`}
          blueprintId={invitation.blueprint_id}
          studentId={invitation.student_id}
          sessionId={activeSessionId ?? undefined}
          apiBaseUrl={API_BASE}
          durationSeconds={durationSeconds ?? 3600}
          onTimerStarted={handleTimerStarted}
          onStarted={activateAssessment}
          onSubmitted={(instanceId) => { setSubmittedInstanceId(instanceId); setStage('completed') }}
        />}
        {stage === 'completed' && <section style={{ ...panelStyle, textAlign: 'center' }}><h1 style={{ color: '#34d399' }}>Assessment submitted</h1><p>Your responses have been queued for evaluation.</p>{submittedInstanceId && <p style={{ color: '#94a3b8', fontSize: 12 }}>Session: {submittedInstanceId}</p>}<button onClick={() => void window.lockdownAPI.quitApp()} style={{ ...buttonStyle, marginTop: 12, background: '#475569' }}>Exit application</button></section>}
        {exitModalOpen && <div style={{ position: 'fixed', inset: 0, zIndex: 5, background: '#000c', display: 'grid', placeItems: 'center', padding: 20 }}><section style={{ ...panelStyle, maxWidth: 400, borderColor: '#9f1239', textAlign: 'center' }}><h3 style={{ color: '#fb7185' }}>Forfeit assessment?</h3><p style={{ fontSize: 13 }}>Exiting ends your test session and notifies the proctor. Type EXIT to confirm.</p><input value={exitConfirmInput} onChange={(event) => setExitConfirmInput(event.target.value)} style={{ ...inputStyle, textAlign: 'center' }} placeholder="EXIT" /><div style={{ display: 'flex', gap: 8, marginTop: 14 }}><button onClick={() => setExitModalOpen(false)} style={{ ...buttonStyle, background: '#334155' }}>Cancel</button><button disabled={exitConfirmInput !== 'EXIT'} onClick={() => void window.lockdownAPI.quitApp()} style={{ ...buttonStyle, background: '#be123c', opacity: exitConfirmInput === 'EXIT' ? 1 : .4 }}>Forfeit & exit</button></div></section></div>}
      </main>
      <footer style={{ flexShrink: 0, height: 32, padding: '0 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff', borderTop: '1px solid #e5e9f2', fontSize: 10, color: '#8490a8' }}><span style={{ color: lockdownActive ? '#159c70' : '#78849e' }}>● {lockdownActive ? 'LOCKDOWN MONITOR ACTIVE' : 'PRE-FLIGHT CHECKS'}</span><span>{invitation ? `Candidate ${invitation.student_id.slice(0, 8)} · Exam ${invitation.blueprint_id.slice(0, 8)}` : 'Waiting for invitation link'}</span></footer>
    </div>
  )
}
