import { useState, type CSSProperties } from 'react'
import { SensitiveField } from './SensitiveField'

interface CandidateLoginFormProps {
  initialEmail?: string
  onSignIn: (email: string, password: string) => Promise<void>
  label?: string
}

export function CandidateLoginForm({ initialEmail = '', onSignIn, label = 'Sign In & View Exams' }: CandidateLoginFormProps) {
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const input: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: 12, marginTop: 6, border: '1px solid #dfe5f1', background: '#fbfcff', color: '#26345c', borderRadius: 9, fontSize: 14 }
  return <form onSubmit={(event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    void onSignIn(email.trim(), password).finally(() => { setPassword(''); setBusy(false) })
  }} aria-busy={busy}>
    <label style={{ display: 'block', fontSize: 14, marginBottom: 14 }}>Email address
      <input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} style={input} />
    </label>
    <SensitiveField label="Password" autoComplete="current-password" required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} style={input} containerStyle={{ fontSize: 14 }} />
    <button type="submit" disabled={busy} style={{ width: '100%', padding: 13, marginTop: 18, border: 0, borderRadius: 9, background: '#596fc9', color: '#fff', fontWeight: 700, fontSize: 14, cursor: busy ? 'wait' : 'pointer', opacity: busy ? .7 : 1 }}>{busy ? 'Verifying your account…' : label}</button>
  </form>
}
