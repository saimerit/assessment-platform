export interface VerifiedSubmissionAttempt { kind: string; id: string; assessmentId: string; token: string; generation: number }
// Only the configured server's candidate-authorized receipt may release native
// controls. A response for a replaced credential cannot affect the next exam.
export async function verifySubmissionReceipt(apiBase: string, attempt: VerifiedSubmissionAttempt, receiptId: string,
  currentGeneration: () => number, transport: typeof fetch = (input, init) => globalThis.fetch(input, init)): Promise<void> {
  const path = attempt.kind === 'session' ? '/exam/sessions/' + encodeURIComponent(attempt.id) : '/assessments/' + encodeURIComponent(attempt.assessmentId)
  const response = await transport(apiBase.replace(/\/$/, '') + path + '/receipt', { headers: { Authorization: `Bearer ${attempt.token}` }, signal: AbortSignal.timeout(5000) })
  const receipt = await response.json() as { submission_id?: string }
  if (!response.ok || receipt.submission_id !== receiptId || attempt.generation !== currentGeneration()) throw new Error('Submission receipt could not be verified')
}
