import { z } from 'zod'
import type { Fact, Project } from '../store/types.js'
import type { RunRecord } from '../store/runs.js'

export const flagPolicySchema = z.object({ mode: z.enum(['first', 'count', 'all']), count: z.number().int().min(1).max(10000).default(2) }).strict()
export type FlagPolicy = z.infer<typeof flagPolicySchema>
export interface FlagProgress { policy: FlagPolicy; found: number; confirmed: number; target?: number }
export function defaultFlagPolicy(flags: { completion: FlagPolicy['mode']; targetCount: number }): FlagPolicy {
  return { mode: flags.completion, count: flags.targetCount }
}
/** Exact, case-sensitive values; notes, goals and rejected answers never count. */
export function collectedFlags(facts: Fact[], runs: RunRecord[]): Map<string, 'unverified' | 'confirmed' | 'rejected'> {
  const values = new Map<string, 'unverified' | 'confirmed' | 'rejected'>()
  for (const run of runs) {
    for (const o of run.flag_observations ?? []) if (o.candidate.kind === 'flag' && !values.has(o.candidate.description.trim())) values.set(o.candidate.description.trim(), 'unverified')
    for (const o of run.outcomes) if (o.candidate?.kind === 'flag') {
      const value = o.candidate.description.trim()
      if (o.state === 'confirmed') values.set(value, 'confirmed')
      else if (o.verification?.verified === false && values.get(value) !== 'confirmed') values.set(value, 'rejected')
      else if (!values.has(value)) values.set(value, 'unverified')
    }
  }
  for (const fact of facts) if (fact.kind === 'flag') {
    const value = (fact.data?.value ?? fact.description).trim()
    if (fact.data?.status === 'rejected') values.set(value, 'rejected')
    else if (fact.verification_status === 'confirmed') values.set(value, 'confirmed')
    else if (!values.has(value)) values.set(value, 'unverified')
  }
  return values
}
export function flagProgress(policy: FlagPolicy, facts: Fact[], runs: RunRecord[]): FlagProgress {
  const statuses = [...collectedFlags(facts, runs).values()]
  return { policy, found: statuses.filter((s) => s !== 'rejected').length, confirmed: statuses.filter((s) => s === 'confirmed').length,
    ...(policy.mode !== 'all' ? { target: policy.mode === 'first' ? 1 : policy.count } : {}) }
}
export function projectFlagPolicy(project: Project): FlagPolicy | undefined {
  return project.purpose === 'writeup' || project.flag_policy === undefined ? undefined : flagPolicySchema.parse(project.flag_policy)
}
export function flagPolicyLabel(policy: FlagPolicy): string {
  return policy.mode === 'first' ? '首个 flag 即停' : policy.mode === 'count' ? `收集 ${policy.count} 个不同 flag` : '持续收集多个 flag'
}
