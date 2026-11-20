import type { CheckpointView } from '../services/AttemptCheckpointClient'
import './AttemptSaveStatus.css'

const labels = { saved: 'Saved to server', saving: 'Saving…', offline: 'Offline · waiting to sync', syncing: 'Syncing…', error: 'Save needs attention', conflict: 'Review conflicting answers' }
export function AttemptSaveStatus({ view, onRetry, onResolve, conflicts = [] }: { view: CheckpointView; onRetry: () => void; onResolve: (keep: 'server' | 'local') => void; conflicts?: { title: string; local: string; server: string }[] }) {
  return <section className={`attempt-save-status is-${view.status}`} aria-label="Answer save status">
    <p role="status" aria-live="polite" className="attempt-save-label"><span aria-hidden="true">●</span> {labels[view.status]}</p>
    <p className="attempt-save-time">{view.savedAt ? `Last server save: ${new Date(view.savedAt).toLocaleTimeString()}` : 'No answers saved yet'}</p>
    {view.recovered && <p className="attempt-save-note">Recovered your saved progress.</p>}
    {view.message && <p className="attempt-save-note">{view.message}</p>}
    {view.localWarning && <p role="alert" className="attempt-save-warning">{view.localWarning}</p>}
    {(view.status === 'error' || view.status === 'offline') && <button className="attempt-save-action" onClick={onRetry}>Retry sync</button>}
    {view.status === 'conflict' && <>
      {conflicts.map((answer, index) => <div className="attempt-conflict-detail" key={index}><strong>{answer.title}</strong><p>On this device: {answer.local}</p><p>Saved on server: {answer.server}</p></div>)}
      <div className="attempt-conflict-actions"><button className="attempt-save-action" onClick={() => onResolve('server')}>Use server-saved answers</button><button className="attempt-save-action" onClick={() => onResolve('local')}>Keep my current changes</button></div>
    </>}
  </section>
}
