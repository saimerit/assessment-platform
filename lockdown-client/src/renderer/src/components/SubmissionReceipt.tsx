import { useEffect, useRef, useState } from 'react'
import type { SubmissionReceipt as Receipt } from '../services/AttemptSubmissionClient'
import './SubmissionReceipt.css'
export function SubmissionReceipt({ receipt, closeAt, closeError, onExit }: { receipt: Receipt; closeAt: number | null; closeError: boolean; onExit: () => void }) {
  const [selected, setSelected] = useState(false)
  const [remaining, setRemaining] = useState(60)
  useEffect(() => {
    if (closeAt === null) return
    const tick = () => setRemaining(Math.max(0, Math.ceil((closeAt - performance.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [closeAt])
  const receiptId = useRef<HTMLElement>(null)
  const selectReceipt = () => {
    if (!receiptId.current) return
    const range = document.createRange()
    range.selectNodeContents(receiptId.current)
    const selection = window.getSelection()
    selection?.removeAllRanges(); selection?.addRange(range)
    setSelected(true)
  }
  return <section className="submission-receipt" aria-label="Submission receipt">
    <div className="submission-receipt-icon" aria-hidden="true">✓</div>
    <p className="submission-receipt-eyebrow">Submission received</p>
    <h1>Assessment submitted</h1>
    <p>Your server-saved responses are secure. Keep this receipt for your records.</p>
    <p>Results are shared only if the assessment organizer chooses to release them.</p>
    {receipt.reason === 'DEADLINE' && <p className="submission-deadline-note">Your exam time ended. The assessment was finalized using responses accepted by the server before the deadline.</p>}
    <dl className="submission-receipt-details">
      <div><dt>Responses received</dt><dd>{receipt.answered_count} of {receipt.question_count}</dd></div>
      <div><dt>{receipt.reason === 'RECOVERED' ? 'Receipt recovered at' : 'Submitted at'}</dt><dd>{new Date(receipt.submitted_at).toLocaleString()}</dd></div>
      <div className="submission-receipt-id"><dt>Receipt ID</dt><dd ref={receiptId} tabIndex={0} onFocus={selectReceipt} aria-label="Receipt ID">{receipt.submission_id}</dd></div>
    </dl>
    <div className="submission-close-note">
      {closeError ? <p role="status">Automatic close could not be scheduled. You can exit now; your submission is received.</p> : <>
        <p>You can exit now. This application closes automatically after one minute.</p>
        <strong aria-label="Application close countdown" aria-live="off">{closeAt === null ? '01:00' : `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`}</strong>
      </>}
    </div>
    <div className="submission-receipt-actions">
      <button onClick={selectReceipt}>{selected ? 'Receipt ID selected' : 'Select receipt ID'}</button>
      <button className="submission-exit" onClick={onExit}>Exit application</button>
    </div>
  </section>
}
