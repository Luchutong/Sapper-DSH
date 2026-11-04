import type { TaskResult } from './result.js'
import type { ChildCapabilities } from '../store/runs.js'
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'

export const actionSchema = z.object({ action: z.enum(['start', 'resume', 'cancel', 'run', 'steer', 'continue']), goal: z.string().max(8000).optional(), task_id: z.string().optional(), purpose: z.enum(['solve', 'writeup']).optional() }).strict()
export type PanelAction = z.infer<typeof actionSchema>
function codec(name: string, create: () => z.ZodType): TypertRemoteCodecSpec { return { mode: 'strict', typeSymbol: 'sapper-dsh.' + name, create } }
const string = codec('sessionId', () => z.string().min(1).max(256)), result = codec('panelResult', () => z.json())
const param = (name: string, value: TypertRemoteCodecSpec) => ({ name, source: 'json' as const, codec: value, strictCodec: value })
export const PANEL_REMOTE = createTypertRemoteInfo({ package: 'sapper-dsh', methods: {
  'sapperPanel/targets': { service: 'sapperPanel', invocation: { kind: 'direct' }, parameters: [], result },
  'sapperPanel/state': { service: 'sapperPanel', invocation: { kind: 'direct' }, parameters: [param('sessionId', string)], result },
  'sapperPanel/report': { service: 'sapperPanel', invocation: { kind: 'direct' }, parameters: [param('sessionId', string)], result },
  'sapperPanel/action': { service: 'sapperPanel', invocation: { kind: 'direct' }, parameters: [param('sessionId', string), param('input', codec('PanelAction', () => actionSchema))], result },
} }, z)
export interface PanelTarget { id: string; cwd: string }
export interface PanelState {
  cwd: string; warnings?: string[]; active: string; tasks: Array<{ id: string; goal: string; created_at: string }>
  job?: { id?: string; state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; error?: string; started_at: string; result?: TaskResult }
  graph?: { goal: string; status: string; facts: number; verified: number; ready: number; integrity: string[]; nodes?: Array<{ id: string; title: string; type: 'fact' | 'intent'; status: string; source_intent?: string | null; from?: string[]; to?: string | null }> }
  runs: Array<{ id: string; state: string; steps: number; explored: number; stop_reason?: string; children?: ChildCapabilities[]; outcomes: Array<{ state: string; intent_id: string; error?: string; candidate?: { title: string; description?: string; kind?: string; reproduction?: string }; verification?: { issues: string; verified: boolean } }> }>
}
export interface PanelApi { targets(): Promise<PanelTarget[]>; state(sessionId: string): Promise<PanelState>; action(sessionId: string, input: PanelAction): Promise<unknown>; report?(sessionId: string): Promise<TaskResult> }
