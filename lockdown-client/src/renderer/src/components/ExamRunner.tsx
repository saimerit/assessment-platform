import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AttemptClient } from '../services/AttemptClient'
import { AttemptCheckpointClient, type CheckpointAnswer, type CheckpointView } from '../services/AttemptCheckpointClient'
import { AttemptSaveStatus } from './AttemptSaveStatus'
import { AttemptSubmissionClient, fetchSubmissionReceipt, type SubmissionReceipt, type SubmissionView } from '../services/AttemptSubmissionClient'
import { SubmissionStatus } from './SubmissionStatus'

interface Option {
  id: string
  text: string
}

interface Question {
  question_id: string
  display_order: number
  title: string
  statement: string
  marks: number
  question_type?: 'MCQ' | 'FIB'
  section_id?: string
  section_name?: string
  options?: Option[]
}

interface ExamRunnerProps {
  blueprintId: string
  studentId: string
  sessionId?: string
  attemptClient: AttemptClient
  durationSeconds: number
  onTimerStarted: (expiresAt: string, serverTime: string) => void
  onStarted: () => Promise<void>
  onSubmitted: (receipt: SubmissionReceipt) => void
}

const buttonStyle: CSSProperties = {
  border: '1px solid #dfe5f1', borderRadius: 9, background: '#fff', color: '#52617f',
  padding: '10px 14px', cursor: 'pointer', fontWeight: 600, boxShadow: '0 3px 10px #24365b0a'
}

export function ExamRunner({
  blueprintId,
  studentId,
  sessionId,
  attemptClient,
  durationSeconds,
  onTimerStarted,
  onStarted,
  onSubmitted
}: ExamRunnerProps) {
  const [questions, setQuestions] = useState<Question[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [activeView, setActiveView] = useState<'home' | 'question'>('home')
  const [remainingSeconds, setRemainingSeconds] = useState(Math.max(0, durationSeconds))
  const [timerDeadlineMs, setTimerDeadlineMs] = useState(() => Date.now() + Math.max(0, durationSeconds) * 1000)
  const [timerClockOffsetMs, setTimerClockOffsetMs] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitModalOpen, setSubmitModalOpen] = useState(false)
  const submissionClient = useRef<AttemptSubmissionClient | null>(null)
  const [submissionView,setSubmissionView] = useState<SubmissionView | null>(null)
  const finalizing = submissionView !== null && ['syncing','submitting','pending','received'].includes(submissionView.status)
  const checkpointClient = useRef<AttemptCheckpointClient | null>(null)
  const recoveryClosing = useRef<Promise<void>>(Promise.resolve())
  const [saveView, setSaveView] = useState<CheckpointView | null>(null)
  const selectedAnswers = useMemo<Record<string, string | string[]>>(() => Object.fromEntries(Object.values(saveView?.answers ?? {}).map(answer => [answer.question_id, answer.typed_response !== null ? answer.typed_response : answer.selected_option_ids])), [saveView])
  const flaggedForReview = useMemo(() => Object.fromEntries(Object.values(saveView?.answers ?? {}).map(answer => [answer.question_id, answer.reviewed])), [saveView])
  const submittingRef = useRef(false)
  const submitRef = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const loadAssessment = async () => {
      setLoading(true)
      setError('')
      try {
        const attemptPath=sessionId ? '/exam/sessions/'+sessionId : '/assessments/'+blueprintId
        const receipt=await fetchSubmissionReceipt(attemptClient,attemptPath,controller.signal)
        if(receipt){await window.lockdownAPI.clearRecovery().catch(()=>{});if(active)onSubmitted(receipt);return}
        if (sessionId) {
          const startResponse = await attemptClient.request(`/exam/sessions/${encodeURIComponent(sessionId)}/start`, { method: 'POST', signal: controller.signal })
          const startData = await startResponse.json().catch(() => ({}))
          if (!startResponse.ok) throw new Error(startData.error || 'Unable to start the exam timer.')
          const deadline = Date.parse(startData.timer_expires_at)
          const serverTime = Date.parse(startData.server_time)
          if (!Number.isFinite(deadline) || !Number.isFinite(serverTime)) throw new Error('The server returned an invalid exam timer.')
          const offset = serverTime - Date.now()
          setTimerDeadlineMs(deadline)
          setTimerClockOffsetMs(offset)
          const initialRemaining = Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000))
          setRemainingSeconds(initialRemaining)
          onTimerStarted(startData.timer_expires_at, startData.server_time)
          await onStarted()
        }
        const response = sessionId
          ? await attemptClient.request(`/exam/sessions/${encodeURIComponent(sessionId)}/questions`, { signal: controller.signal })
          : await attemptClient.request(`/assessments/${blueprintId}/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student_id: studentId }),
          signal: controller.signal
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Unable to load the assessment paper.')
        if (!Array.isArray(data.questions) || data.questions.length === 0) {
          throw new Error('No questions are available. Contact your assessment coordinator.')
        }
        if (!active) return
        if (!sessionId) {
          const deadline = Date.parse(data.timer_expires_at), serverTime = Date.parse(data.server_time)
          if (!Number.isFinite(deadline) || !Number.isFinite(serverTime)) throw new Error('Invalid server exam timer.')
          setTimerDeadlineMs(deadline); setTimerClockOffsetMs(serverTime - Date.now())
          onTimerStarted(data.timer_expires_at, data.server_time)
          await onStarted()
        }
        if (!active) return
        const paper = data.questions as Question[]
        await recoveryClosing.current
        if (!active) return
        const owner = new AttemptCheckpointClient(attemptClient, sessionId ? '/exam/sessions/' + sessionId + '/checkpoint' : '/assessments/' + blueprintId + '/checkpoint', {
          read: () => window.lockdownAPI.readRecovery(), write: value => window.lockdownAPI.writeRecovery(value), clear: () => window.lockdownAPI.clearRecovery()
        }, view => {
          if (!active) return
          setSaveView(view)
          const index = paper.findIndex(question => question.question_id === view.navigation.question_id)
          if (index >= 0) setCurrentIndex(index)
          setActiveView(view.navigation.active_view)
        }, new Set(paper.map(question => question.question_id)))
        checkpointClient.current = owner
        await owner.open()
        submissionClient.current=new AttemptSubmissionClient(attemptClient,attemptPath,owner,view=>{if(active)setSubmissionView(view)})
        if (active) setQuestions(data.questions as Question[])
      } catch (cause) {
        if (active && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Failed to load assessment questions.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadAssessment()
    return () => {
      active = false
      controller.abort()
      submissionClient.current?.dispose()
      recoveryClosing.current = checkpointClient.current?.dispose() ?? Promise.resolve()
      checkpointClient.current = null
    }
  }, [attemptClient, blueprintId, onStarted, onTimerStarted, sessionId, studentId])

  const handleSubmitFinal = useCallback(async () => {
    if(submittingRef.current || !submissionClient.current) return
    submittingRef.current=true;setIsSubmitting(true);setError('')
    const deadline=Date.now()+timerClockOffsetMs>=timerDeadlineMs
    const receipt=await submissionClient.current.finalize(deadline)
    if(receipt)onSubmitted(receipt)
    else {setIsSubmitting(false);setSubmitModalOpen(false)}
    submittingRef.current=false
  },[onSubmitted,timerDeadlineMs,timerClockOffsetMs])

  useEffect(() => { submitRef.current = handleSubmitFinal }, [handleSubmitFinal])

  useEffect(() => {
    if (loading || questions.length === 0) return
    let deadlineSubmitted = false
    const tick = () => {
      if (deadlineSubmitted) return
      const next = Math.max(0, Math.ceil((timerDeadlineMs - (Date.now() + timerClockOffsetMs)) / 1000))
      setRemainingSeconds(next)
      if (next === 0) {
        deadlineSubmitted = true
        window.clearInterval(timer)
        void submitRef.current()
      }
    }
    const timer = window.setInterval(tick, 500)
    tick()
    return () => window.clearInterval(timer)
  }, [loading, questions.length, timerDeadlineMs, timerClockOffsetMs])

  useEffect(() => {
    const retry = () => { if(Date.now()+timerClockOffsetMs>=timerDeadlineMs || submissionView?.status==='pending')void submitRef.current();else void checkpointClient.current?.flush() }
    const timer = window.setInterval(retry, 5000)
    window.addEventListener('online', retry)
    return () => { window.clearInterval(timer); window.removeEventListener('online', retry) }
  }, [submissionView?.status,timerDeadlineMs,timerClockOffsetMs])

  if (loading) {
    return <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', color: '#94a3b8' }}>Loading assessment paper…</div>
  }

  if (error && questions.length === 0) {
    return <div role="alert" style={{ margin: 'auto', maxWidth: 560, padding: 28, color: '#bd4055', textAlign: 'center' }}>{error}</div>
  }

  const currentQuestion = questions[currentIndex]
  if (!currentQuestion && activeView === 'question') return null
  const hasResponse = (response: string | string[] | undefined) => Array.isArray(response) ? response.length > 0 : !!response?.trim()
  const answeredCount = Object.values(selectedAnswers).filter(hasResponse).length
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  const sections = questions.reduce<{ id: string; name: string; indices: number[] }[]>((groups, question, index) => {
    const id = question.section_id || 'assessment-questions'
    let section = groups.find((item) => item.id === id)
    if (!section) { section = { id, name: question.section_name || 'Assessment questions', indices: [] }; groups.push(section) }
    section.indices.push(index)
    return groups
  }, [])
  const currentSection = sections.find((section) => section.indices.includes(currentIndex))
  const conflictDetails = saveView?.conflicts.map(id => {
    const question = questions.find(item => item.question_id === id)
    const describe = (answer: CheckpointAnswer | undefined) => {
      if (!answer) return 'Not answered'
      const response = answer.typed_response?.trim() || answer.selected_option_ids.map(optionId => question?.options?.find(option => option.id === optionId)?.text ?? 'Selected option').join(', ') || 'Not answered'
      return response + (answer.reviewed ? ' · Flagged for review' : '')
    }
    return { title: question?.title ?? 'Question', local: describe(saveView.answers[id]), server: describe(saveView.serverAnswers[id]) }
  }) ?? []

  const openQuestion = (index: number) => {
    checkpointClient.current?.navigate({ question_id: questions[index].question_id, active_view: 'question' })
  }
  const openOverview = () => checkpointClient.current?.navigate({ question_id: questions[currentIndex]?.question_id ?? null, active_view: 'home' })
  const saveResponse = (response: string | string[]) => {
    if (!currentQuestion || remainingSeconds === 0) return
    const existing = saveView?.answers[currentQuestion.question_id]
    checkpointClient.current?.change({ question_id: currentQuestion.question_id,
      selected_option_ids: Array.isArray(response) ? response : [], typed_response: typeof response === 'string' ? response : null,
      reviewed: existing?.reviewed ?? false })
  }
  const toggleReview = () => {
    if (!currentQuestion || remainingSeconds === 0) return
    const existing = saveView?.answers[currentQuestion.question_id] ?? { question_id: currentQuestion.question_id,
      selected_option_ids: [], typed_response: currentQuestion.question_type === 'FIB' ? '' : null, reviewed: false }
    checkpointClient.current?.change({ ...existing, reviewed: !existing.reviewed })
  }

  return (
    <div className="exam-layout" style={{ display: 'flex', height: '100%', minHeight: 0, gap: 16, color: '#33415f' }}>
      <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 22, overflowY: 'auto', background: '#fff', border: '1px solid #e2e7f1', borderRadius: 14, boxShadow: '0 12px 35px #26375f0a' }}>
        {activeView === 'home' ? <>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', paddingBottom: 16, borderBottom: '1px solid #edf0f6' }}>
            <div><div style={{ color: '#6879bf', fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>Assessment home</div><h1 style={{ margin: '5px 0', color: '#2d3b60', fontSize: 21 }}>Question overview</h1><div style={{ color: '#71809b', fontSize: 12 }}>Choose any question to answer. You can return here at any time.</div></div>
            <div style={{ borderRadius: 10, background: '#f2f4ff', padding: '9px 13px', color: '#5267b1', fontSize: 12, fontWeight: 700 }}>{answeredCount} of {questions.length} answered</div>
          </div>
          <div style={{ display: 'grid', gap: 13, marginTop: 16 }}>
            {sections.map((section, sectionIndex) => <section key={section.id} style={{ overflow: 'hidden', border: '1px solid #e2e7f2', borderRadius: 11, background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 14px', background: '#f1f3fc', borderBottom: '1px solid #e5e9f4' }}><div><div style={{ color: '#6477c5', fontSize: 9, fontWeight: 800, letterSpacing: 1 }}>SECTION {sectionIndex + 1}</div><h2 style={{ margin: '3px 0 0', color: '#34446c', fontSize: 14 }}>{section.name}</h2></div><span style={{ color: '#75819a', fontSize: 10 }}>{section.indices.length} questions</span></div>
              <div>{section.indices.map((index, questionIndex) => {
                const question = questions[index]
                const response = selectedAnswers[question.question_id]
                const answered = hasResponse(response)
                const flagged = Boolean(flaggedForReview[question.question_id])
                return <button key={question.question_id} onClick={() => openQuestion(index)} style={{ width: '100%', display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) auto auto', alignItems: 'center', gap: 10, padding: '10px 13px', textAlign: 'left', cursor: 'pointer', border: 0, borderBottom: questionIndex < section.indices.length - 1 ? '1px solid #eef0f5' : 0, background: '#fff' }}>
                  <span style={{ display: 'grid', width: 27, height: 27, placeItems: 'center', borderRadius: 8, background: '#f0f2fb', color: '#6779c3', fontSize: 10, fontWeight: 700 }}>{index + 1}</span>
                  <span style={{ minWidth: 0, color: '#3c4969', fontSize: 12, fontWeight: 600 }}>{question.title}</span>
                  <span style={{ borderRadius: 999, background: flagged ? '#fff6e2' : answered ? '#e9f8f1' : '#f4f5f9', color: flagged ? '#a97819' : answered ? '#21835f' : '#77829a', padding: '4px 7px', fontSize: 9, whiteSpace: 'nowrap' }}>{flagged ? 'Review' : answered ? 'Answered' : 'Not answered'}</span>
                  <span style={{ color: '#6779c3', fontSize: 10, whiteSpace: 'nowrap' }}>{question.marks} pts →</span>
                </button>
              })}</div>
            </section>)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}><button onClick={() => openQuestion(currentIndex)} style={{ ...buttonStyle, background: '#6277c9', color: '#fff', borderColor: '#6277c9' }}>Continue to question {currentIndex + 1} →</button></div>
        </> : currentQuestion && <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 14, borderBottom: '1px solid #edf0f6' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><button onClick={openOverview} style={{ ...buttonStyle, padding: '7px 10px', fontSize: 11 }}>← Question overview</button><div style={{ fontSize: 13, color: '#71809b' }}>Question {currentIndex + 1} of {questions.length} · {currentQuestion.marks} marks</div></div>
          <button disabled={remainingSeconds === 0 || isSubmitting || finalizing} onClick={toggleReview} style={{ ...buttonStyle, color: flaggedForReview[currentQuestion.question_id] ? '#b27c22' : '#65728c', background: flaggedForReview[currentQuestion.question_id] ? '#fff8e8' : '#fff' }}>
            {flaggedForReview[currentQuestion.question_id] ? '★ Flagged for review' : '☆ Mark for review'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 14 }} aria-label="Exam sections">{sections.map((section, index) => <button key={section.id} onClick={() => openQuestion(section.indices[0])} aria-current={currentSection?.id === section.id ? 'step' : undefined} style={{ ...buttonStyle, padding: '7px 10px', fontSize: 10, color: currentSection?.id === section.id ? '#fff' : '#64718e', background: currentSection?.id === section.id ? '#6277c9' : '#f8f9fd', borderColor: currentSection?.id === section.id ? '#6277c9' : '#e9edf5', boxShadow: 'none' }}>Section {index + 1} · {section.name} <span style={{ opacity: .75 }}>({section.indices.length})</span></button>)}</div>
        {currentSection && <div style={{ marginTop: 18, color: '#6878b6', fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>{currentSection.name}</div>}
        <h2 style={{ margin: '7px 0 10px', color: '#2d3b60', fontSize: 20 }}>{currentQuestion.title}</h2>
        <div style={{ padding: 16, borderRadius: 10, background: '#f7f8fc', border: '1px solid #edf0f6', color: '#56627b', whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{currentQuestion.statement}</div>
        <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
          {currentQuestion.question_type === 'FIB' ? <input
            aria-label="Your answer" disabled={remainingSeconds === 0 || isSubmitting || finalizing}
            value={typeof selectedAnswers[currentQuestion.question_id] === 'string' ? selectedAnswers[currentQuestion.question_id] as string : ''}
            onChange={(event) => saveResponse(event.target.value)}
            placeholder="Type your answer"
            style={{ width: '100%', boxSizing: 'border-box', marginTop: 18, padding: 12, border: '1px solid #dfe5f1', borderRadius: 9, background: '#fff', color: '#33415f' }}
          /> : <>
            {(currentQuestion.options?.length ?? 0) > 1 && <p style={{ margin: '2px 0 0', color: '#71809b', fontSize: 11 }}>Select all correct answers.</p>}
            {(currentQuestion.options ?? []).map((option, index) => {
            const existing = selectedAnswers[currentQuestion.question_id]
            const selected = Array.isArray(existing) && existing.includes(option.id)
            return <button key={option.id} disabled={remainingSeconds === 0 || isSubmitting || finalizing} onClick={() => {
              const current = Array.isArray(selectedAnswers[currentQuestion.question_id]) ? selectedAnswers[currentQuestion.question_id] as string[] : []
              saveResponse(selected ? current.filter((id) => id !== option.id) : [...current, option.id])
            }} aria-pressed={selected} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 10, textAlign: 'left', color: selected ? '#4058a9' : '#53617b', background: selected ? '#f0f2ff' : '#fff', border: `1px solid ${selected ? '#acb8eb' : '#e5e9f2'}`, cursor: 'pointer' }}><span style={{ width: 18, height: 18, display: 'grid', placeItems: 'center', borderRadius: 5, border: `1px solid ${selected ? '#687bc8' : '#cbd3e2'}`, color: '#fff', background: selected ? '#687bc8' : '#fff', fontSize: 12, flexShrink: 0 }}>{selected ? '✓' : ''}</span><b>{String.fromCharCode(65 + index)}.</b>{option.text}</button>
          })}
          </>}
        </div>
        <div style={{ marginTop: 'auto', paddingTop: 22, display: 'flex', justifyContent: 'space-between' }}>
          <button disabled={currentIndex === 0} onClick={() => openQuestion(Math.max(0, currentIndex - 1))} style={{ ...buttonStyle, opacity: currentIndex === 0 ? 0.45 : 1 }}>← Previous</button>
          {currentIndex < questions.length - 1
            ? <button onClick={() => openQuestion(Math.min(questions.length - 1, currentIndex + 1))} style={{ ...buttonStyle, background: '#6277c9', color: '#fff', borderColor: '#6277c9' }}>Next question →</button>
            : <button onClick={openOverview} style={{ ...buttonStyle, background: '#6277c9', color: '#fff', borderColor: '#6277c9' }}>Back to question overview</button>}
        </div>
        </>}
      </section>

      <aside style={{ width: 292, flexShrink: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 18, background: '#fff', border: '1px solid #e2e7f1', borderRadius: 14, boxShadow: '0 12px 35px #26375f0a' }}>
        <div style={{ padding: 15, textAlign: 'center', background: '#f8fafc', border: '1px solid #dbe3ef', borderRadius: 11 }}><div style={{ color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: .8 }}>Exam duration remaining</div><strong style={{ display: 'block', marginTop: 6, fontSize: 28, fontVariantNumeric: 'tabular-nums', color: remainingSeconds < 300 ? '#be4056' : '#334155' }}>{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</strong></div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: 11, color: '#40506f' }}><b>Question palette</b><span style={{ color: '#8792a8' }}>{answeredCount}/{questions.length} answered</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 7 }}>
            {questions.map((question, index) => {
              const response = selectedAnswers[question.question_id]
              const selected = hasResponse(response)
              const flagged = Boolean(flaggedForReview[question.question_id])
              return <button key={question.question_id} onClick={() => openQuestion(index)} aria-label={`Go to question ${index + 1}${selected ? ', answered' : ''}${flagged ? ', flagged for review' : ''}`} style={{ ...buttonStyle, padding: '8px 0', fontSize: 11, background: flagged ? '#fff7e4' : selected ? '#e9f8f1' : '#f8f9fc', color: flagged ? '#a97819' : selected ? '#21835f' : '#65718a', borderColor: currentIndex === index && activeView === 'question' ? '#6c7ed0' : '#e7ebf3', outline: currentIndex === index && activeView === 'question' ? '2px solid #d5daf5' : 'none', boxShadow: 'none' }}>{index + 1}</button>
            })}
          </div>
        </div>
        {saveView && !finalizing && <AttemptSaveStatus view={saveView} conflicts={conflictDetails} onRetry={() => void checkpointClient.current?.flush()} onResolve={keep => checkpointClient.current?.resolveConflict(keep)} />}
        {submissionView && submissionView.status!=='idle' && submissionView.status!=='received' && <SubmissionStatus view={submissionView} onRetry={()=>void handleSubmitFinal()} />}
        {error && <div role="alert" style={{ color: '#bd4055', fontSize: 12 }}>{error}</div>}
        {submissionView?.status!=='pending' && <button disabled={isSubmitting || finalizing} onClick={() => setSubmitModalOpen(true)} style={{ ...buttonStyle, marginTop: 'auto', background: '#218f69', color: '#fff', borderColor: '#218f69' }}>{isSubmitting ? 'Submitting…' : 'Submit assessment'}</button>}
      </aside>

      {submitModalOpen && <div style={{ position: 'fixed', inset: 0, zIndex: 20, display: 'grid', placeItems: 'center', padding: 20, background: '#000c' }}>
        <section style={{ width: 'min(400px, 100%)', padding: 24, border: '1px solid #e0e5ef', borderRadius: 14, background: '#fff', color: '#33415f', boxShadow: '0 20px 60px #18284a30' }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Confirm submission</h2>
          <p style={{ color: '#6b7892', fontSize: 13 }}>You answered {answeredCount} of {questions.length} questions. Submit your assessment now?</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button onClick={() => setSubmitModalOpen(false)} disabled={isSubmitting} style={buttonStyle}>Review answers</button>
            <button onClick={() => void handleSubmitFinal()} disabled={isSubmitting} style={{ ...buttonStyle, background: '#218f69', color: '#fff', borderColor: '#218f69' }}>{isSubmitting ? 'Submitting…' : 'Confirm submit'}</button>
          </div>
        </section>
      </div>}
    </div>
  )
}
