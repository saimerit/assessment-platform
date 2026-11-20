import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ExamRunner } from './components/ExamRunner'
import { CandidateLoginForm } from './components/CandidateLoginForm'
import { SensitiveField } from './components/SensitiveField'
import { ScheduleDashboard } from './components/ScheduleDashboard'
import { PaperMetrics, PaperPatternTable } from './components/PaperSummary'
import type { IntakeField, ExamInvitation, CandidateAssessment } from './types/assessment'
import { AttemptClient } from './services/AttemptClient'
import { fetchSubmissionReceipt, type SubmissionReceipt as Receipt } from './services/AttemptSubmissionClient'
import { SubmissionReceipt } from './components/SubmissionReceipt'

const API_BASE = window.lockdownAPI.apiBaseUrl

type EntryMode = 'link' | 'login'
type Stage = 'entry' | 'identity' | 'loading' | 'error' | 'schedule' | 'intake' | 'terms' | 'diagnostics' | 'tutorial' | 'overview' | 'exam' | 'completed'

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
  const [candidateAccountId, setCandidateAccountId] = useState('')
  const [attemptClient] = useState(() => new AttemptClient(API_BASE, (token) => window.lockdownAPI.setAttemptToken(token)))
  const [accessError, setAccessError] = useState('')
  const [assignedExams, setAssignedExams] = useState<CandidateAssessment[]>([])
  const [invitation, setInvitation] = useState<ExamInvitation | null>(null)
  const [invitationToken, setInvitationToken] = useState('')
  const [form, setForm] = useState<Record<string, string>>({})
  const [passcode, setPasscode] = useState('')
  const [receipt,setReceipt] = useState<Receipt | null>(null)
  const [receiptCloseAt, setReceiptCloseAt] = useState<number | null>(null)
  const [receiptCloseError, setReceiptCloseError] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [examTimerExpiresAt, setExamTimerExpiresAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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
  const examActiveRef = useRef(false)
  const invitationLoadRef = useRef(0)

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

  const receiveReceipt=useCallback((value:Receipt)=>{
    examActiveRef.current=false
    streamRef.current?.getTracks().forEach(track=>track.stop())
    if(audioFrameRef.current!==null)cancelAnimationFrame(audioFrameRef.current)
    void audioContextRef.current?.close().catch(()=>{})
    setReceipt(value);setAccessError('');setStage('completed')
    setReceiptCloseAt(null);setReceiptCloseError(false)
    void window.lockdownAPI.releaseAfterSubmission(value.submission_id).then(remainingMs => {
      setLockdownActive(false);setReceiptCloseAt(performance.now() + remainingMs)
    }).catch(()=>setReceiptCloseError(true))
  },[])
  const restoreReceipt=useCallback(async (exam:ExamInvitation)=>{
    if(exam.window_status!=='SUBMITTED')return false
    const path=exam.session_id?'/exam/sessions/'+exam.session_id:'/assessments/'+exam.blueprint_id
    const received=await fetchSubmissionReceipt(attemptClient,path)
    if(!received)throw new Error('Your submission receipt is being recovered. Please retry shortly.')
    await window.lockdownAPI.clearRecovery().catch(()=>{});receiveReceipt(received);return true
  },[attemptClient,receiveReceipt])
  const loadInvitation = useCallback(async (token: string) => {
    if (examActiveRef.current) return
    const loadVersion = ++invitationLoadRef.current
    setStage('loading')
    setError('')
    try {
      const normalizedToken = extractInvitationToken(token)
      if (!normalizedToken) throw new Error('Enter an invitation token or complete exam link.')
      const response = await fetch(`${API_BASE}/exg/${encodeURIComponent(normalizedToken)}`)
      const data = await response.json().catch(() => null)
      if (loadVersion !== invitationLoadRef.current) return
      if (!response.ok) throw new Error(data?.error || `Invitation API returned HTTP ${response.status}. Check that the Assessment API is running at ${API_BASE}.`)
      if (!data) throw new Error(`Invitation API at ${API_BASE} returned a non-JSON response.`)
      const exam = data as ExamInvitation
      syncClockFromServer(exam.server_time)
      setInvitationToken(normalizedToken)
      setInvitation(exam)
      setExamTimerExpiresAt(exam.timer_expires_at ?? null)
      const initialForm: Record<string, string> = { full_name: exam.candidate_name, email: exam.email }
      setForm(initialForm)
      setPasscode('')
      setAccessError('')
      setActiveSessionId(null)
      if (attemptClient.signedIn) {
        try {
          await attemptClient.authorize(normalizedToken)
          if (loadVersion !== invitationLoadRef.current) return
          if(!(await restoreReceipt(exam)))setStage('schedule')
        } catch (cause) {
          if (loadVersion !== invitationLoadRef.current) return
          setError(cause instanceof Error ? cause.message : 'Sign in with the invited candidate account.')
          setStage('identity')
        }
      } else {
        await attemptClient.reset()
        if (loadVersion !== invitationLoadRef.current) return
        setStage('identity')
      }
    } catch (cause) {
      if (loadVersion !== invitationLoadRef.current) return
      setError(cause instanceof Error ? cause.message : 'Unable to load this exam invitation.')
      setStage('entry')
    }
  }, [attemptClient, syncClockFromServer,restoreReceipt])

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

  const handleCandidateLogin = async (email: string, password: string) => {
    setError('')
    try {
      await attemptClient.reset(true)
      setCandidateAccountId('')
      const account = await attemptClient.signIn(email, password)
      setCandidateAccountId(account.id)
      if (stage === 'identity' && invitationToken) {
        await attemptClient.authorize(invitationToken)
        if(invitation && !(await restoreReceipt(invitation)))setStage('schedule')
      } else { setAssignedExams(await attemptClient.assignedAssessments() as CandidateAssessment[]) }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Candidate sign-in failed.')
    }
  }

  useEffect(() => {
    if (!invitationToken || stage === 'entry' || stage === 'identity' || stage === 'loading' || stage === 'completed') return
    let active = true
    const renew = async () => {
      try { await attemptClient.refresh(); if (active) setAccessError('') }
      catch (cause) { if (active) setAccessError(cause instanceof Error ? cause.message : 'Assessment access could not reconnect.') }
    }
    const timer = window.setInterval(() => void renew(), 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [attemptClient, invitationToken, stage])

  const openGateway = async () => {
    const token = extractInvitationToken(manualToken)
    if (!token) {
      setError('Enter an invitation token or exam link first.')
      return
    }
    try {
      await window.lockdownAPI.openExternal(`${window.lockdownAPI.portalBaseUrl.replace(/\/+$/, '')}/exg/${encodeURIComponent(token)}`)
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

  const resumingAttempt = !!invitation?.started_at && attemptClient.isUnlocked

  const startExam = async () => {
    if (!invitation) return
    setBusy(true)
    setError('')
    try {
      const sessionId = invitation.session_id
      if (!resumingAttempt) {
        const endpoint = sessionId
          ? `/exam/sessions/${encodeURIComponent(sessionId)}/unlock`
          : `/assessments/${invitation.blueprint_id}/verify-passcode`
        const payload = sessionId
          ? { passcode, camera_ready: cameraReady, microphone_ready: micReady }
          : { passcode, student_id: invitation.student_id }
        const verify = await attemptClient.request(endpoint, { method: 'POST', body: JSON.stringify(payload) })
        const verifyData = await verify.json().catch(() => null)
        if (!verify.ok) throw new Error(verifyData?.error || 'Invalid or expired invigilator passcode.')
        if (verifyData?.server_time) syncClockFromServer(verifyData.server_time)
        setExamTimerExpiresAt(null)
      }
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
    examActiveRef.current = true
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
      <header style={{ minHeight: 54, flexShrink: 0, padding: '10px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, background: '#fff', borderBottom: '1px solid #e5e9f2', fontSize: 12, boxShadow: '0 3px 14px #293c6808' }}>
        <strong style={{ letterSpacing: 1, color: '#445a9f' }}>✦ OA SECURE CLIENT</strong>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 12, color: '#68748e' }}>
          <span style={{ color: online ? '#18a875' : '#e15d69' }}>● {online ? `Network ${networkLatency === null ? 'online' : `${networkLatency} ms`}` : 'Offline'}</span>
          {battery !== null && <span>Battery {battery}%</span>}
          {invitation && stage !== 'completed' && <span aria-live="off" title="Server-checked schedule window. Entry must begin within this slot." style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 7, padding: '6px 9px', background: '#f8fafc', border: '1px solid #e2e8f0', color: windowTimerSeconds === null ? '#be4056' : '#475569', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}><span>{windowTimerLabel}</span>{windowTimerSeconds !== null && <code style={{ background: 'transparent', color: 'inherit', padding: 0 }}>{formatTimer(windowTimerSeconds)}</code>}</span>}
          {(stage === 'exam' || invitation?.window_status === 'IN_PROGRESS') && examTimerSeconds !== null && <span aria-live="off" title="Candidate's separate exam-duration timer. It starts when the exam is entered." style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 7, padding: '6px 9px', background: '#eef2ff', border: '1px solid #dbe3ff', color: examTimerSeconds < 300 ? '#be4056' : '#40569f', fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap' }}><span>Exam timer</span><code style={{ background: 'transparent', color: 'inherit', padding: 0 }}>{formatTimer(examTimerSeconds)}</code></span>}
          <code style={{ display: 'inline-block', border: '1px solid #dbe3ef', borderRadius: 6, background: '#f1f5f9', color: '#334155', padding: '6px 8px', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{clock.toLocaleTimeString()}</code>
          <button onClick={handleClose} aria-label={lockdownActive ? 'Forfeit and exit assessment' : 'Close client'} title={lockdownActive ? 'Forfeit and exit assessment' : 'Close client'} style={{ color: '#c94d64', background: '#fff5f6', border: '1px solid #f3d3d9', borderRadius: 8, padding: '7px 11px', cursor: 'pointer' }}>✕ Close</button>
        </div>
      </header>
      {accessError && <p role="status" style={{ margin: 0, padding: 12, background: '#fff7ed', color: '#9a3412', fontSize: 14 }}>{accessError}</p>}
      <main style={{ flex: 1, overflow: 'auto', padding: stage === 'exam' ? 18 : 24, display: stage === 'exam' ? 'block' : 'flex', alignItems: stage === 'schedule' || stage === 'overview' || stage === 'completed' ? 'flex-start' : 'center', justifyContent: 'center', background: 'radial-gradient(circle at 12% 5%, #edf0ff 0, transparent 28%), radial-gradient(circle at 88% 95%, #eef5ff 0, transparent 30%), #f7f8fc' }}>
        {stage !== 'exam' && stage !== 'completed' && <section style={stage === 'schedule' ? { ...panelStyle, width: 'min(1080px, 100%)', flexShrink: 0 } : stage === 'overview' ? { ...panelStyle, width: 'min(1020px, 100%)', maxHeight: '100%', overflowY: 'auto' } : panelStyle}>
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
              <SensitiveField label="Invitation token or exam URL" visibilityLabel="invitation token or link" value={manualToken} onChange={(event) => setManualToken(event.target.value)} placeholder="Paste your invitation token or link" style={inputStyle} autoComplete="off" containerStyle={{ color: '#6e7a94', fontSize: 13 }} />
              <button style={{ ...buttonStyle, marginTop: 14 }} disabled={busy || !manualToken.trim()} onClick={() => void loadInvitation(manualToken)}>{busy ? 'Loading…' : 'Load Assessment'}</button>
              <button style={{ ...buttonStyle, width: '100%', marginTop: 9 }} disabled={!manualToken.trim()} onClick={() => void openGateway()}>Open Gateway in Browser ↗</button>
              <p style={{ color: '#8994aa', textAlign: 'center', fontSize: 11, marginBottom: 0 }}>Use your invitation link or token from the assessment email.</p>
            </div>}
            {entryMode === 'login' && <div>
              {!candidateAccountId ? <CandidateLoginForm onSignIn={handleCandidateLogin} /> : <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}><b style={{ fontSize: 13 }}>Assigned assessments</b><button onClick={() => { setCandidateAccountId(''); setAssignedExams([]); void attemptClient.reset(true) }} style={{ ...buttonStyle, width: 'auto', padding: '6px 9px', fontSize: 13 }}>Sign out</button></div>
                {assignedExams.length === 0 ? <p style={{ color: '#94a3b8', fontSize: 13 }}>No active assessments are assigned to this account.</p> : <div style={{ display: 'grid', gap: 9, maxHeight: 240, overflowY: 'auto' }}>
                  {assignedExams.map((exam) => <button key={exam.invitation_token} onClick={() => void loadInvitation(exam.invitation_token)} style={{ ...buttonStyle, textAlign: 'left', background: '#fff', color: '#33436c', border: '1px solid #e3e8f3', boxShadow: 'none' }}><b style={{ display: 'block' }}>{exam.exam_title}</b><span style={{ color: '#7b87a0', fontSize: 11 }}>Status: {exam.status} · {new Date(exam.scheduled_start).toLocaleString()}</span><span style={{ display: 'block', color: '#596fc9', fontSize: 11, marginTop: 5 }}>Review exam →</span></button>)}
                </div>}
              </div>}
            </div>}
          </>}
          {stage === 'loading' && <div><h2>Secure Exam Gateway</h2><p style={{ color: '#7a86a0' }}>Waiting for your personal exam link…</p></div>}
          {stage === 'identity' && invitation && <>
            <p style={{ margin: 0, color: '#596fc9', fontSize: 14, fontWeight: 700 }}>Verify candidate account</p>
            <h1 style={{ margin: '8px 0', fontSize: 24 }}>{invitation.exam_title}</h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: '#53617f', marginBottom: 22 }}>Sign in with the account invited as <strong>{invitation.email}</strong> to continue. {invitation.window_status === 'SUBMITTED' ? 'Your assessment is already submitted. Sign in to retrieve its receipt.' : 'Your exam timer starts after the access code and checks are complete.'}</p>
            <CandidateLoginForm key={invitationToken} initialEmail={invitation.email} onSignIn={handleCandidateLogin} label="Verify account & continue" />
            <button onClick={() => { setStage('entry'); setInvitation(null); setError(''); setCandidateAccountId(''); void attemptClient.reset(true) }} style={{ marginTop: 16, background: 'transparent', color: '#596fc9', border: 0, cursor: 'pointer', padding: 6, fontSize: 14 }}>Use another invitation</button>
          </>}
          {stage === 'error' && <div><h2>Unable to load invitation</h2><p style={{ color: '#7a86a0', fontSize: 13 }}>Check that the Assessment API is running and that this invitation link is valid.</p></div>}
          {stage === 'schedule' && invitation && <ScheduleDashboard invitation={invitation} onContinue={() => { setError(''); setStage('intake') }} />}
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
            {resumingAttempt ? <p style={{ color: '#596681', fontSize: 13, lineHeight: 1.6 }}>Your account is verified for this started attempt. Resume your saved answers and review flags; the original exam timer is still running.</p> : <SensitiveField label="Invigilator passcode" visibilityLabel="passcode" value={passcode} onChange={(event) => { setPasscode(event.target.value); setError('') }} disabled={busy} style={inputStyle} autoComplete="off" containerStyle={{ margin: '16px 0', fontSize: 13 }} />}
            <button style={buttonStyle} disabled={busy || (!resumingAttempt && !passcode)} onClick={() => void startExam()}>{busy ? (resumingAttempt ? 'Preparing resume…' : 'Verifying passcode…') : (resumingAttempt ? 'Resume & review questions' : 'Verify passcode & review questions')}</button>
          </>}
          {stage === 'overview' && invitation && <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 18 }}><div><p style={{ margin: '0 0 5px', color: '#6679c8', fontSize: 11, fontWeight: 800, letterSpacing: 1.3, textTransform: 'uppercase' }}>Assessment outline</p><h1 style={{ margin: 0, color: '#27365f', fontSize: 23 }}>{invitation.exam_title}</h1><p style={{ margin: '7px 0 0', color: '#7a86a0', fontSize: 12 }}>Review the sections and question list before entering the exam.</p></div><span style={{ borderRadius: 999, background: '#eef0ff', color: '#5b6fbd', padding: '7px 11px', fontSize: 11, fontWeight: 700 }}>{invitation.proctoring_mode?.replaceAll('_', ' ') ?? 'Assessment'}</span></div>
            <PaperMetrics invitation={invitation} />
            <div className="assessment-paper-card" style={{ marginBottom: 18 }}>
              <div className="assessment-paper-heading"><h2>Question paper pattern</h2><span>{invitation.paper_code ?? 'Assigned paper'}</span></div>
              <PaperPatternTable sections={invitation.sections ?? []} emptyMessage="The question outline is not available for this legacy assessment. You can continue to the exam." />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, borderTop: '1px solid #e9ecf4', paddingTop: 15 }}><span style={{ color: '#8792a9', fontSize: 10 }}>{resumingAttempt ? 'Resume the original paper and timer. Time continues while the client is closed.' : 'The scheduled window controls when you may start. Your exam-duration timer begins only after you enter.'}</span><button style={{ ...buttonStyle, width: 'auto', minWidth: 230, padding: '12px 18px' }} onClick={() => { setError(''); setStage('exam') }}>{resumingAttempt ? 'Engage lockdown & resume exam →' : 'Engage lockdown & start exam →'}</button></div>
          </>}
        </section>}
        {stage === 'diagnostics' && <button onClick={() => void runDiagnostics()} style={{ position: 'fixed', bottom: 56, padding: '7px 12px', borderRadius: 8, color: '#64718b', background: '#fff', border: '1px solid #e1e6f0', fontSize: 12 }}>Run hardware checks</button>}
        {stage === 'exam' && invitation && <ExamRunner
          key={`${invitation.blueprint_id}:${invitation.student_id}`}
          blueprintId={invitation.blueprint_id}
          studentId={invitation.student_id}
          sessionId={activeSessionId ?? undefined}
          attemptClient={attemptClient}
          durationSeconds={durationSeconds ?? 3600}
          onTimerStarted={handleTimerStarted}
          onStarted={activateAssessment}
          onSubmitted={receiveReceipt}
        />}
        {stage === 'completed' && receipt && <SubmissionReceipt receipt={receipt} closeAt={receiptCloseAt} closeError={receiptCloseError} onExit={()=>void window.lockdownAPI.quitApp()} />}
        {exitModalOpen && <div style={{ position: 'fixed', inset: 0, zIndex: 5, background: '#000c', display: 'grid', placeItems: 'center', padding: 20 }}><section style={{ ...panelStyle, maxWidth: 400, borderColor: '#9f1239', textAlign: 'center' }}><h3 style={{ color: '#fb7185' }}>Forfeit assessment?</h3><p style={{ fontSize: 13 }}>Exiting ends your test session and notifies the proctor. Type EXIT to confirm.</p><input value={exitConfirmInput} onChange={(event) => setExitConfirmInput(event.target.value)} style={{ ...inputStyle, textAlign: 'center' }} placeholder="EXIT" /><div style={{ display: 'flex', gap: 8, marginTop: 14 }}><button onClick={() => setExitModalOpen(false)} style={{ ...buttonStyle, background: '#334155' }}>Cancel</button><button disabled={exitConfirmInput !== 'EXIT'} onClick={() => void window.lockdownAPI.quitApp()} style={{ ...buttonStyle, background: '#be123c', opacity: exitConfirmInput === 'EXIT' ? 1 : .4 }}>Forfeit & exit</button></div></section></div>}
      </main>
      <footer style={{ flexShrink: 0, height: 32, padding: '0 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff', borderTop: '1px solid #e5e9f2', fontSize: 10, color: '#8490a8' }}><span style={{ color: lockdownActive ? '#159c70' : '#78849e' }}>● {stage==='completed' ? 'ASSESSMENT SUBMITTED' : lockdownActive ? 'LOCKDOWN MONITOR ACTIVE' : 'PRE-FLIGHT CHECKS'}</span><span>{invitation ? `Candidate ${invitation.student_id.slice(0, 8)} · Exam ${invitation.blueprint_id.slice(0, 8)}` : 'Waiting for invitation link'}</span></footer>
    </div>
  )
}
