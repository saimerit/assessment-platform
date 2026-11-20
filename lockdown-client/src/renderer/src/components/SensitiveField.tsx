import { useEffect, useId, useState, type CSSProperties, type InputHTMLAttributes } from 'react'
import './SensitiveField.css'

interface SensitiveFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string
  visibilityLabel?: string
  containerStyle?: CSSProperties
}

export function SensitiveField({ label, visibilityLabel = label.toLowerCase(), containerStyle, id, style, value, disabled, ...inputProps }: SensitiveFieldProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (disabled || value === '') setVisible(false)
  }, [disabled, value])

  const action = `${visible ? 'Hide' : 'Show'} ${visibilityLabel}`
  return <div className="sensitive-field" style={containerStyle}>
    <label htmlFor={inputId}>{label}</label>
    <div className="sensitive-field-control" style={{ marginTop: style?.marginTop ?? 6 }}>
      <input {...inputProps} id={inputId} value={value} disabled={disabled} type={visible ? 'text' : 'password'} style={{ ...style, marginTop: 0, paddingRight: 52 }} />
      <button type="button" className="sensitive-field-toggle" onClick={() => setVisible(current => !current)} disabled={disabled} aria-label={action} title={action} aria-controls={inputId} aria-pressed={visible} data-visible={visible}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <g className="sensitive-eye-open">
            <path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="2.8" />
          </g>
          <g className="sensitive-eye-closed">
            <path d="M3 9.5c2 3.2 5 5 9 5s7-1.8 9-5M5 12l-2 2.5M9 14l-1 3M15 14l1 3M19 12l2 2.5" />
          </g>
        </svg>
      </button>
    </div>
  </div>
}
