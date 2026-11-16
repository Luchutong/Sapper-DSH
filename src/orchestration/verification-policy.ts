import { z } from 'zod'
import type { Candidate } from '../store/runs.js'
import type { CapturedCall } from './types.js'

export const verificationModeSchema = z.enum(['none', 'lightweight', 'selective', 'independent'])
export type VerificationMode = z.infer<typeof verificationModeSchema>
export interface EvidenceCheck { mode: 'none' | 'lightweight'; passed: boolean; checks: string[]; issues: string[] }
export function checkCandidateEvidence(candidate: Candidate, calls: Map<string, CapturedCall>, mode: 'none' | 'lightweight'): EvidenceCheck {
  const checks = ['成功工具回执与当前子会话归属已校验'], issues: string[] = []
  if (mode === 'none') return { mode, passed: true, checks, issues }
  const critical = ['flag', 'vuln', 'cred', 'loot'].includes(candidate.kind)
  const cited = [...new Set(candidate.evidence.map((e) => e.call_id))].map((id) => calls.get(id)).filter((c): c is CapturedCall => !!c)
  if (critical) {
    if (cited.length < 2) issues.push('重要结论尚无第二次工具检查；保留观察，不启动额外代理')
    else checks.push('已引用至少两次成功工具调用')
    if (candidate.kind === 'flag') {
      const matches = cited.filter((c) => c.text.includes(candidate.description.trim()))
      if (matches.length < 2) issues.push('flag 未在两次引用的原始输出中一致出现')
      else checks.push('flag 字面值在两次原始输出中一致')
    }
  }
  return { mode, passed: issues.length === 0, checks, issues }
}
