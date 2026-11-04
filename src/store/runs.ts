import type { FactKind } from './types.js'
import { object, text, StoreError } from './validation.js'

export interface Evidence { call_id: string; tool: string; excerpt: string; receipt_id?: string; sha256?: string }
export interface Candidate {
  title: string; description: string; kind: FactKind; evidence: Evidence[]; explorer_session: string; reproduction?: string
}
export interface Verification { verified: boolean; evidence: Evidence[]; issues: string; verifier_session: string; goal_achieved?: boolean }
export interface RunOutcome {
  intent_id: string; state: 'pending-verification' | 'confirmed' | 'failed' | 'stopped'; candidate?: Candidate
  verification?: Verification; verify_attempts: number; fact_id?: string; error?: string
}
export interface RunRecord {
  id: string; mode: 'reason' | 'explore' | 'verify' | 'run'; parent_session: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'; created_at: string; updated_at: string
  steps: number; explored: number; outcomes: RunOutcome[]; intent_ids: string[]; stop_reason?: string
  children?: ChildCapabilities[]
  flag_observations?: Array<{ intent_id: string; candidate: Candidate }>
}
export interface ChildCapabilities {
  tool_selectors?: readonly string[]; provider?: string; model?: string; reasoning_effort?: string
  role: 'reason' | 'explore' | 'verify'; session_id: string; tools: string[]; external_tools: string[]; max_output_tokens: number
  state?: 'running' | 'completed' | 'failed' | 'stopped'; steps?: number; step_limit?: number; step_ceiling?: number; extensions?: number; finalizing?: boolean; started_at?: string; ended_at?: string
}
export function runId(value: unknown): string {
  if (typeof value !== 'string' || !/^r\d{3,}$/.test(value)) throw new StoreError('run_id 必须形如 r001')
  return value
}
export function validateRun(value: unknown): RunRecord {
  const data = object(value, 'run')
  runId(data.id)
  for (const key of ['parent_session', 'created_at', 'updated_at']) text(data[key], key)
  if (!['reason', 'explore', 'verify', 'run'].includes(String(data.mode)) || !['running', 'completed', 'failed', 'cancelled'].includes(String(data.state))) throw new StoreError('run mode/state 无效')
  for (const key of ['steps', 'explored']) if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) throw new StoreError('run 计数无效')
  if (!Array.isArray(data.outcomes) || !Array.isArray(data.intent_ids)) throw new StoreError('run outcomes/intent_ids 无效')
  return data as unknown as RunRecord
}
