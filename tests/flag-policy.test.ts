import { expect, it } from 'vitest'
import { collectedFlags, flagPolicySchema, flagProgress } from '../src/orchestration/flag-policy.js'
import { checkCandidateEvidence } from '../src/orchestration/verification-policy.js'
import { parseCandidate } from '../src/orchestration/types.js'
import type { Candidate, RunRecord } from '../src/store/runs.js'
import { resolveConfig } from '../src/settings.js'
import { flagLiterals } from '../src/orchestration/flags.js'

const candidate = (value: string): Candidate => ({ title: value, description: value, kind: 'flag', explorer_session: 'explore', evidence: [{ call_id: 'call1', tool: 'read', excerpt: value }] })
it('counts exact distinct flags and excludes rejected answers and non-flag observations', () => {
  const run = { id: 'r001', mode: 'run', parent_session: 'main', state: 'completed', created_at: 'now', updated_at: 'now', steps: 1, explored: 1, intent_ids: [], outcomes: [{ intent_id: 'i001', state: 'failed', verify_attempts: 1, candidate: candidate('flag{bad}'), verification: { verified: false, evidence: [], issues: 'wrong', verifier_session: 'verify' } }],
    flag_observations: ['flag{A}', 'flag{A}', 'flag{a}', 'flag{bad}'].map((v) => ({ intent_id: 'i001', candidate: candidate(v) })) } as RunRecord
  run.flag_observations!.push({ intent_id: 'i002', candidate: { ...candidate('flag{note-only}'), kind: 'note' } })
  const progress = flagProgress({ mode: 'count', count: 3 }, [], [run])
  expect(progress).toMatchObject({ found: 2, confirmed: 0, target: 3 })
  expect(collectedFlags([], [run]).get('flag{bad}')).toBe('rejected')
})
it('keeps the fast default configurable and rejects invalid flag targets', () => {
  expect(resolveConfig().verification.mode).toBe('lightweight')
  expect(resolveConfig({ verification: { mode: 'none' } }).verification.mode).toBe('none')
  expect(() => flagPolicySchema.parse({ mode: 'count', count: 0 })).toThrow()
  expect(() => flagPolicySchema.parse({ mode: 'count', count: 2.5 })).toThrow()
})
it('does not accept an invented flag merely because an unrelated tool receipt exists', () => {
  const calls = new Map([['call1', { tool: 'read', receipt_id: 'ev-valid', text: 'no answer in this output' }]])
  expect(() => parseCandidate({ ...candidate('flag{invented}'), evidence: [{ receipt_id: 'ev-valid' }] }, 'explore', calls)).toThrow('实际出现')
})
it('requires two actual calls for lightweight critical evidence, not duplicate citations', () => {
  const value = 'flag{two}', c = candidate(value), calls = new Map([['call1', { tool: 'read', text: value }]])
  c.evidence.push({ ...c.evidence[0]! })
  expect(checkCandidateEvidence(c, calls, 'lightweight').passed).toBe(false)
})
it('preserves all distinct flags from a single tool output instead of silently truncating at sixteen', () => {
  const values = Array.from({ length: 24 }, (_, i) => `CTF2{MULTI-${i}}`)
  expect(flagLiterals(values.join('\n'))).toEqual(values)
})
it('keeps an unbound MCP flag visible but does not count it as a target completion', () => {
  const run = { id: 'r001', mode: 'run', parent_session: 'main', state: 'completed', created_at: 'now', updated_at: 'now', steps: 1, explored: 1, intent_ids: [], outcomes: [], flag_observations: [{ intent_id: 'i001', candidate: { ...candidate('flag{unbound}'), source: 'unbound' } }] } as RunRecord
  expect(run.flag_observations).toHaveLength(1)
  expect(flagProgress({ mode: 'first', count: 1 }, [], [run]).found).toBe(0)
})
