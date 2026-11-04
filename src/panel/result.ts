export interface TaskResult {
  phase?: 'accepted' | 'progress' | 'direction' | 'flag-found' | 'result'; activity?: Array<{ at: string; stage: string }>
  job_id: string; task_id: string; run_id?: string; goal: string; state: string; summary: string
  confirmed: Array<{ id: string; title: string; description: string; kind: string }>
  candidates: Array<{ title: string; description: string; kind: string; status: 'unverified' | 'rejected' }>
  errors: string[]; stop_reason?: string
}
declare module '@deepseek-ai/dsh-session' { interface SessionEventMap { 'sapper/result': TaskResult } }
declare module '@deepseek-ai/dsh-client-ui-chat/client' { interface ChatNodeDataMap { 'sapper-result': TaskResult } }
