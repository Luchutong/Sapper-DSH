import type { RunRecord } from '../store/runs.js'
import type { TaskResult } from '../panel/result.js'

/** Discovery is an unverified observation, never a correctness/submission claim.
 * Only call this on successful external tool output, not prompts or model text. */
export function flagLiterals(output: string): string[] {
  return [...new Set(output.match(/\b(?:flag|ctf\d*|[a-z][a-z0-9_]{0,24}ctf\d*|htb|thm)\{[^\s{}]{1,256}\}/gi) ?? [])]
}

/** Keep early observations visible when subsequent phase/progress cards replace
 * the first notice. A verified note cannot confirm a flag it happens to quote. */
export function runCandidates(run: RunRecord): TaskResult['candidates'] {
  const candidates = new Map<string, TaskResult['candidates'][number]>()
  for (const candidate of [
    ...(run.flag_observations ?? []).map((o) => o.candidate),
    ...run.outcomes.flatMap((o) => o.candidate ? [o.candidate] : []),
  ]) {
    const matches = run.outcomes.filter((o) => o.candidate?.kind === candidate.kind && o.candidate.description === candidate.description)
    if (matches.some((o) => o.state === 'confirmed')) continue
    candidates.set(candidate.kind + ':' + candidate.description, {
      ...(candidate.source ? { source: candidate.source } : {}), title: candidate.title, description: candidate.description, kind: candidate.kind,
      status: matches.some((o) => o.verification?.verified === false) ? 'rejected' : 'unverified',
      ...(matches.find((o) => o.evidence_check)?.evidence_check ? { evidence_check: matches.find((o) => o.evidence_check)!.evidence_check! } : {}),
    })
  }
  return [...candidates.values()]
}
