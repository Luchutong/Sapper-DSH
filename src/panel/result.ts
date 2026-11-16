export interface TaskResult {
  flag_progress?: import('../orchestration/flag-policy.js').FlagProgress
  verification_mode?: import('../orchestration/verification-policy.js').VerificationMode
  attachments?: import('../workbench/contracts.js').PublicAttachment[]
  phase?: 'accepted' | 'progress' | 'direction' | 'flag-found' | 'result'
  activity?: Array<{ at: string; stage: string }>
  wp_path?: string
  session_id?: string
  job_id: string
  task_id: string
  run_id?: string
  goal: string
  state: string
  summary: string
  confirmed: Array<{
    id: string
    title: string
    description: string
    kind: string
  }>
  candidates: Array<{
    title: string
    description: string
    kind: string
    source?: 'target' | 'unbound'
    status: 'unverified' | 'rejected'
    evidence_check?: import('../orchestration/verification-policy.js').EvidenceCheck
  }>
  errors: string[]
  stop_reason?: string
}
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'sapper/result': TaskResult
  }
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'sapper-result': TaskResult
  }
}

export const RESULT_RECORD = 'plugin:sapper-dsh/result'
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:sapper-dsh/result': TaskResult
  }
}
