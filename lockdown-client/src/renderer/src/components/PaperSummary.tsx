import type { ExamInvitation, ExamSection } from '../types/assessment'
import './AssessmentDashboard.css'

const questionLabels: Record<string, string> = {
  MCQ: 'Multiple choice', MULTI_SELECT: 'Multiple select', MSQ: 'Multiple select',
  FIB: 'Fill in the blank'
}

export function PaperMetrics({ invitation }: { invitation: ExamInvitation }) {
  const sections = invitation.sections ?? []
  const metrics = [
    { label: 'Sections', value: sections.length || '—' },
    { label: 'Questions', value: sections.length ? sections.reduce((sum, section) => sum + section.question_count, 0) : '—' },
    { label: 'Total marks', value: sections.length ? sections.reduce((sum, section) => sum + section.total_marks, 0) : '—' },
    { label: 'Duration', value: invitation.duration_minutes ? `${invitation.duration_minutes} min` : '—' }
  ]
  return <dl className="assessment-metrics" aria-label="Assessment summary">
    {metrics.map(metric => <div key={metric.label} className="assessment-metric">
      <dt>{metric.label}</dt><dd>{metric.value}</dd>
    </div>)}
  </dl>
}

export function PaperPatternTable({ sections, emptyMessage }: { sections: ExamSection[]; emptyMessage: string }) {
  if (!sections.length) return <p className="assessment-empty">{emptyMessage}</p>
  return <div className="assessment-table-scroll" role="region" aria-label="Question paper pattern table" tabIndex={0}>
    <table className="assessment-pattern-table">
      <caption className="assessment-sr-only">Question formats, counts and marks by section</caption>
      <thead><tr><th scope="col">Section</th><th scope="col">Question format</th><th scope="col" className="assessment-number">Questions</th><th scope="col" className="assessment-number">Marks</th></tr></thead>
      <tbody>{sections.map((section, sectionIndex) => {
        const formats = Object.entries(section.question_types ?? {})
        const rows: [string, number][] = formats.length ? formats : [['', section.question_count]]
        return rows.map(([type, count], formatIndex) => <tr key={`${section.id || sectionIndex}:${type}`}>
          {formatIndex === 0 && <th scope="rowgroup" rowSpan={rows.length}><span className="assessment-section-number">Section {sectionIndex + 1}</span>{section.name}</th>}
          <td>{questionLabels[type] ?? (type || 'Assigned questions')}{type && <span className="assessment-format-code">{type}</span>}</td>
          <td className="assessment-number">{count}</td>
          <td className="assessment-number">{type ? section.marks_by_type?.[type] ?? '—' : section.total_marks}</td>
        </tr>)
      })}</tbody>
      <tfoot><tr><th scope="row" colSpan={2}>Paper total</th><td className="assessment-number">{sections.reduce((sum, section) => sum + section.question_count, 0)}</td><td className="assessment-number">{sections.reduce((sum, section) => sum + section.total_marks, 0)}</td></tr></tfoot>
    </table>
  </div>
}
