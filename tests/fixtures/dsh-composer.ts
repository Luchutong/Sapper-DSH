import type { CommandClaim } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { dshClientProbe } from './dsh-client-artifact.js'

interface Attempt { seq: number; signal: AbortSignal }
interface Effect { type: string; attempt: Attempt; claim: CommandClaim; args: string }
interface Composer { readonly state: { phase: string }; dispatch(event: object): Effect[] }
/** Execute the exact pure submit machine shipped in DSH's pinned browser artifact.
 * Its package-private class is not exported by the lazy-CJS entry. No UI state
 * transitions are copied or mocked here; changing the SDK artifact fails loudly.
 */
export async function dshComposer(): Promise<Composer> {
  const { SubmitMachine } = await dshClientProbe<{ SubmitMachine: new () => Composer }>('@deepseek-ai/dsh-client-ui-conversation', ['SubmitMachine'])
  return new SubmitMachine()
}
