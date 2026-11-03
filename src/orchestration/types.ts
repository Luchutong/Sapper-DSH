/** M3 contracts: candidates must be verified before becoming confirmed facts. */
export type DispatchMode = 'reason' | 'explore' | 'verify'

export interface CandidateResult {
  intentId: string
  title: string
  description: string
  evidence: string
  state: 'pending-verification'
}

export type VerificationResult =
  | { verified: true; evidence: string }
  | { verified: false; issues: string }

export interface DispatchRequest {
  mode: DispatchMode
  intentId?: string
  signal: AbortSignal
}

// No dispatcher is registered before the DSH subagent/approval seam is verified.
