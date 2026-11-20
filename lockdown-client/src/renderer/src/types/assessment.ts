export interface IntakeField {
  key: string
  label: string
  type: 'text' | 'email' | 'tel'
  required: boolean
}

export interface ExamSection {
  id: string
  name: string
  question_count: number
  total_marks: number
  question_types: Record<string, number>
  marks_by_type: Record<string, number>
}

export interface ExamInvitation {
  blueprint_id: string
  student_id: string
  session_id?: string
  assessment_id?: string
  paper_id?: string
  paper_code?: string
  paper_set_name?: string
  proctoring_mode?: 'ONLINE_PROCTORING' | 'OFFLINE_NORMAL' | 'OFFLINE_PROCTORING'
  duration_minutes?: number
  candidate_name: string
  email: string
  exam_title: string
  scheduled_start: string
  scheduled_end: string
  server_time: string
  window_status: 'NOT_OPEN' | 'OPEN' | 'IN_PROGRESS' | 'CLOSED' | 'EXPIRED' | 'SUBMITTED'
  started_at?: string
  timer_expires_at?: string
  intake_fields?: IntakeField[]
  sections?: ExamSection[]
}

export interface CandidateAssessment {
  invitation_token: string
  blueprint_id: string
  exam_title: string
  scheduled_start: string
  scheduled_end: string
  status: string
}
