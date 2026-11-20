import type { SubmissionView } from '../services/AttemptSubmissionClient'
import './SubmissionReceipt.css'
export function SubmissionStatus({ view, onRetry }: { view: SubmissionView; onRetry: () => void }) {
  return <section className="submission-status" role="status" aria-live="polite">
    <strong>{view.status === 'pending' ? 'Awaiting submission confirmation' : view.status === 'error' ? 'Submission needs attention' : 'Finalizing assessment'}</strong>
    <p>{view.message}</p>
    {(view.status === 'pending' || view.status === 'error') && <button onClick={onRetry}>Retry confirmation</button>}
  </section>
}
