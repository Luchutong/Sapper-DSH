import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { FACT_KINDS, object, text, StoreError, id } from '../store/validation.js'
import type { Evidence, Candidate, Verification } from '../store/runs.js'
import { createHash } from 'node:crypto'

export type DispatchMode = 'reason' | 'explore' | 'verify' | 'run'
const str = { type: 'string' } as const
const evidence = { type: 'array', items: { type: 'object', properties: { receipt_id: str }, required: ['receipt_id'], additionalProperties: false } } satisfies NonNullable<ObjectJsonSchema['properties']>[string]
export const SCHEMAS: Record<'reason' | 'explore' | 'verify', ObjectJsonSchema> = {
  reason: { type: 'object', properties: { intents: { type: 'array', items: { type: 'object', properties: {
    title: str, description: str, from: { type: 'array', items: str }, success_criteria: str, completes_goal: { type: 'boolean' },
  }, required: ['title', 'description', 'from', 'success_criteria'], additionalProperties: false } } }, required: ['intents'], additionalProperties: false },
  explore: { type: 'object', properties: { title: str, description: str, kind: { type: 'string', enum: [...FACT_KINDS] }, evidence }, required: ['title', 'description', 'kind', 'evidence'], additionalProperties: false },
  verify: { type: 'object', properties: { verified: { type: 'boolean' }, evidence, issues: str, goal_achieved: { type: 'boolean' } }, required: ['verified', 'evidence', 'issues'], additionalProperties: false },
}
export interface CapturedCall { tool: string; text: string; receipt_id?: string }
export function checkedEvidence(value: unknown, calls: Map<string, CapturedCall>): Evidence[] {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new StoreError('缺少实际工具证据（需要 1–12 条）')
  return value.map(item => {
    const ref = object(item, 'evidence')
    if (typeof ref.receipt_id === 'string') {
      const match = [...calls].find(([, call]) => call.receipt_id === ref.receipt_id)
      if (!match) throw new StoreError('证据回执必须来自本子会话已成功调用的外部工具')
      const [callId, call] = match
      return { receipt_id: ref.receipt_id, call_id: callId, tool: call.tool, excerpt: call.text.slice(0, 4000), sha256: createHash('sha256').update(call.text).digest('hex') }
    }
    // Historical callers may still supply exact excerpts; never unescape model text into evidence.
    const excerpt = text(ref.excerpt, 'excerpt')
    let callId = typeof ref.call_id === 'string' ? ref.call_id : ''
    if (!callId) {
      const matches = [...calls].filter(([, call]) => call.text.includes(excerpt))
      if (matches.length === 1) callId = matches[0]![0]
    }
    const call = calls.get(callId)
    if (!call || excerpt.length < 4 || excerpt.length > 4000 || !call.text.includes(excerpt)) throw new StoreError('证据必须引用本子会话已成功调用的工具输出及其原文片段')
    return { call_id: callId, tool: call.tool, excerpt }
  })
}
export function parseCandidate(value: unknown, session: string, calls: Map<string, CapturedCall>): Candidate {
  const v = object(value, 'candidate')
  if (!FACT_KINDS.includes(v.kind as never)) throw new StoreError('候选 kind 无效')
  return { title: text(v.title, 'title'), description: text(v.description, 'description'), kind: v.kind as Candidate['kind'], evidence: checkedEvidence(v.evidence, calls), explorer_session: session }
}
export function parseVerification(value: unknown, session: string, calls: Map<string, CapturedCall>): Verification {
  const v = object(value, 'verification')
  if (typeof v.verified !== 'boolean') throw new StoreError('verified 必须是布尔值')
  return { verified: v.verified, evidence: v.verified ? checkedEvidence(v.evidence, calls) : [], issues: v.verified ? String(v.issues ?? '') : text(v.issues, 'issues'), verifier_session: session, goal_achieved: v.goal_achieved === true }
}
export function parseProposals(value: unknown) {
  const v = object(value, 'reason')
  if (!Array.isArray(v.intents) || v.intents.length > 4) throw new StoreError('reason 最多提出 4 条意图')
  return v.intents.map(item => {
    const i = object(item, 'intent')
    if (!Array.isArray(i.from) || !i.from.length) throw new StoreError('reason 意图必须引用已有事实')
    return { title: text(i.title, 'title'), description: text(i.description, 'description'), from: i.from.map(x => id(x, 'fact')), doc: 'Success criteria: ' + text(i.success_criteria, 'success_criteria'), completes_goal: i.completes_goal === true }
  })
}
