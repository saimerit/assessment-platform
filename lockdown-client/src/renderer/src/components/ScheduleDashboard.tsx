import type { ExamInvitation } from '../types/assessment'
import { PaperMetrics, PaperPatternTable } from './PaperSummary'
import './AssessmentDashboard.css'

function ScheduleTime({ value }: { value: string }) {
  const date = new Date(value)
  return <time dateTime={value}><strong>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><span>{date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span></time>
}

export function ScheduleDashboard({ invitation, onContinue }: { invitation: ExamInvitation; onContinue: () => void }) {
  const canContinue = invitation.window_status === 'OPEN' || invitation.window_status === 'IN_PROGRESS'
  const active = invitation.window_status === 'IN_PROGRESS'
  const status = active ? 'Attempt active' : invitation.window_status === 'OPEN' ? 'Window open' : invitation.window_status === 'CLOSED' ? 'Window closed' : 'Not open yet'
  const action = active ? 'Resume your exam' : invitation.window_status === 'OPEN' ? 'Continue to candidate details' : invitation.window_status === 'CLOSED' ? 'Exam window closed' : 'Waiting for exam window…'
  return <div className="assessment-dashboard">
    <div className="assessment-dashboard-heading">
      <div><p className="assessment-eyebrow">Confirm your assessment</p><h1>{invitation.exam_title}</h1><p className="assessment-description">Review your schedule and paper before completing check-in.</p></div>
      <span className={`assessment-status ${canContinue ? 'is-open' : invitation.window_status === 'CLOSED' ? 'is-closed' : 'is-waiting'}`}><span aria-hidden="true">●</span> {status}</span>
    </div>
    <PaperMetrics invitation={invitation} />
    <div className="assessment-detail-grid">
      <section className="assessment-detail-card" aria-labelledby="candidate-summary-title">
        <h2 id="candidate-summary-title">Candidate &amp; assessment</h2>
        <dl className="assessment-details">
          <div><dt>Candidate</dt><dd>{invitation.candidate_name}</dd></div>
          <div><dt>Email</dt><dd>{invitation.email}</dd></div>
          <div><dt>Exam mode</dt><dd>{invitation.proctoring_mode?.replaceAll('_', ' ').toLowerCase().replace(/^./, letter => letter.toUpperCase()) ?? 'Assessment'}</dd></div>
          {invitation.paper_code && <div><dt>Paper</dt><dd>{invitation.paper_code}{invitation.paper_set_name ? ` · ${invitation.paper_set_name}` : ''}</dd></div>}
        </dl>
      </section>
      <section className="assessment-detail-card" aria-labelledby="schedule-window-title">
        <h2 id="schedule-window-title">Your entry window</h2>
        <div className="assessment-window-times"><div><span className="assessment-time-label">Exam opens</span><ScheduleTime value={invitation.scheduled_start} /></div><span className="assessment-window-arrow" aria-hidden="true">→</span><div><span className="assessment-time-label">Exam closes</span><ScheduleTime value={invitation.scheduled_end} /></div></div>
        <p className="assessment-window-note">Start within this window. {active ? 'Your original exam timer continues when you resume.' : 'Your exam timer begins when you enter the exam.'}</p>
      </section>
    </div>
    <section className="assessment-paper-card" aria-labelledby="paper-pattern-title">
      <div className="assessment-paper-heading"><h2 id="paper-pattern-title">Question paper pattern</h2><span>{invitation.paper_code ?? 'Assigned paper'}</span></div>
      <PaperPatternTable sections={invitation.sections ?? []} emptyMessage="Paper pattern will be available after a question paper is assigned." />
      {invitation.paper_id && <p className="assessment-paper-id">QP ID: {invitation.paper_id}</p>}
    </section>
    <div className="assessment-dashboard-footer">
      <div><p className="assessment-server-status">{canContinue ? active ? 'Resume before your exam timer expires.' : 'You may continue with check-in.' : invitation.window_status === 'CLOSED' ? 'This assessment is no longer available to start.' : 'Entry will become available at the scheduled start.'}</p><p className="assessment-server-time">Server checked: {new Date(invitation.server_time).toLocaleString()}</p></div>
      <button className="assessment-primary-action" disabled={!canContinue} onClick={onContinue}>{action}{canContinue && <span aria-hidden="true"> →</span>}</button>
    </div>
  </div>
}
