import { interactionAdapterSchema, nativeOperationSchema } from './adapters/interactive-schema.js'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const id = z.string().trim().min(1).max(256)
export const mcpSelector = z.string().regex(/^mcp__[A-Za-z0-9_.-]+(?:__[A-Za-z0-9_.-]+|__\*)$|^mcp__\*$/)
export const capabilityId = z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/).max(160)
export const profileSchema = z.object({
  id, label: id, backendId: id,
  selectors: z.array(mcpSelector).min(1).max(128),
  capabilities: z.array(capabilityId).max(128).default([]),
  roles: z.array(z.enum(['explore', 'verify'])).min(1).default(['explore', 'verify']),
  workspaceIds: z.array(id).max(256).default([]),
  isolation: z.enum(['exclusive-workflow', 'stateless', 'dedicated-instance', 'explicit-handle']).default('exclusive-workflow'),
  maxInstances: z.number().int().min(1).max(32).default(1),
  maxInFlight: z.number().int().min(1).max(32).default(1),
  providerId: id.optional(),
  native: z.object({ open: nativeOperationSchema, close: nativeOperationSchema, verify: nativeOperationSchema, handlePath: id, argumentPath: id, closeConfirmedPath: id, identityPath: id, expectedIdentity: id, tools: z.array(z.string().regex(/^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/)).min(1).max(128) }).strict().optional(),
  // Optional native probe. Its schema/permission is checked as a separate call.
  identity: z.object({ tool: z.string().regex(/^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/), arguments: z.record(z.string(), z.json()).default({}), resultPath: id, expected: id }).strict().optional(),
  interaction: interactionAdapterSchema.optional(),
  measurements: z.array(z.object({ tool: z.string().regex(/^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/), claim: id, valuePath: id, unit: z.string().max(64).default(''), validity: z.enum(['asset', 'resource-epoch', 'state-revision']).default('resource-epoch'), assetDigestPath: id.optional() }).strict()).max(128).default([]),
  handleArgument: id.optional(),
  targetTools: z.array(z.string().regex(/^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/)).max(128).default([]),
  bindings: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  effects: z.record(z.string().regex(/^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/), z.enum(['read', 'write', 'control', 'unknown'])).default({}),
}).strict().superRefine((p, ctx) => {
  if (p.providerId === 'native-handle' && (!p.native || p.isolation !== 'explicit-handle')) ctx.addIssue({ code: 'custom', message: 'native-handle 需要原生句柄适配，且只能声明 explicit-handle 隔离' })
  if (p.interaction && p.native) ctx.addIssue({ code: 'custom', message: '交互映射与原生资源工厂不能在同一配置组叠加生命周期' })
  if (p.interaction && p.isolation === 'stateless') ctx.addIssue({ code: 'custom', message: '交互式会话不能配置为无状态服务' })
  if (['dedicated-instance', 'explicit-handle'].includes(p.isolation) && !p.providerId)
    ctx.addIssue({ code: 'custom', message: '独立实例/资源句柄必须选择已注册的实例提供者', path: ['providerId'] })
})
export type ToolProfile = z.infer<typeof profileSchema>
export const brokerPolicySchema = z.object({
  selection: z.enum(['auto', 'all']).default('auto'),
  waitMs: z.number().int().min(100).max(3600000).default(300000),
  profiles: z.array(profileSchema).max(128).default([]),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.profiles.map((x) => x.id)).size !== p.profiles.length)
    ctx.addIssue({ code: 'custom', message: '资源配置组 ID 不能重复' })
  // One backend is one concurrency contract; aliases must not change its limit.
  for (const p1 of p.profiles) for (const p2 of p.profiles) if (p1.id < p2.id && p1.backendId === p2.backendId &&
    (p1.isolation !== p2.isolation || p1.maxInstances !== p2.maxInstances || p1.maxInFlight !== p2.maxInFlight || p1.providerId !== p2.providerId))
    ctx.addIssue({ code: 'custom', message: `同一后端 ${p1.backendId} 的隔离与容量必须一致` })
})
export type BrokerPolicy = z.infer<typeof brokerPolicySchema>
export interface BrokerOwner {
  hostInstanceId: string; workspaceId: string; taskId: string; runId: string; agentId: string
  role: 'reason' | 'explore' | 'verify' | 'main'; cwd: string; purpose?: string
}
export interface ResourceLease {
  id: string; ownerId: string; key: string; slot: number; backendId: string; fence: number; epoch: number
  exclusive?: boolean | undefined
  state: 'active' | 'draining' | 'released' | 'quarantined'; startedAt: string; heartbeatAt: string
  assurance: 'serialized' | 'process' | 'verified-handle'; error?: string | undefined
}
export interface BrokerReceipt {
  protocol: 'sapper-mcp/1'; kind: 'receipt'; receiptId: string; invocationId: string; callId: string
  owner: { hostInstanceId: string; workspaceId: string; challengeId?: string; taskId?: string; runId?: string; agentId: string; role: 'reason' | 'explore' | 'verify' | 'main'; sessionId?: string }
  toolRef: { connectionRef: string; publicName: string; schemaDigest: string }
  argumentsDigest: string; resultDigest: string
  resource: { backendId: string; resourceId: string; kind: 'generic' | 'stateless'; generation: number }
  target: { assetRefs: string[]; assetDigests: string[]; binding: 'attested' | 'unattested' | 'not-applicable'; identities?: Array<{ type: 'opaque'; value: string }> }
  fence: number; epoch: number; status: 'success' | 'error' | 'cancelled'; source: 'target' | 'unbound'
  artifacts: Array<{ ref: string; digest: string; mediaType: string; bytes: number }>
  startedAt: string; endedAt: string; errorCode?: 'TOOL_ERROR' | 'CANCELLED'
}
export interface Selection {
  revision: number; selected: string[]; requiredCapabilities: string[]; missingCapabilities: string[]
  excluded: Array<{ name: string; reason: string }>
}
export type ProviderNativeInvoke = (name: string, arguments_: unknown) => Promise<ToolExecutionResult>
export interface ResourceInstance {
  resourceId: string; generation: number; assurance: 'process' | 'verified-handle'
  /** Exact already-registered native tools. Parent policy remains authoritative. */
  tools: string[]
  lifecycleTools?: string[]
  assetDigests?: string[]
  /** Immutable native argument bindings, e.g. database_id/session_id. */
  bindings?: Record<string, string>
  verify(agent: Agent, signal: AbortSignal, invoke: ProviderNativeInvoke): Promise<boolean>
  close(signal: AbortSignal, invoke?: ProviderNativeInvoke): Promise<void>
}
export interface ResourceProvider {
  open(input: { profile: ToolProfile; owner: BrokerOwner; slot: number; fence: number; signal: AbortSignal }): Promise<ResourceInstance>
}
export interface BrokerSnapshot {
  policy: BrokerPolicy; revision: number; durable: boolean; hostInstanceId: string
  leases: ResourceLease[]; waiting: Array<{ id: string; ownerId: string; keys: string[]; since: string }>
  owners: BrokerOwner[]
  providers: string[]; receipts: BrokerReceipt[]; warnings: string[]
}
export interface ManagedContext {
  owner: BrokerOwner; parent: Agent; selectors: readonly string[]; text: string; requested: string[]
  signal: AbortSignal; guard(): void; progress(stage: string): Promise<void>
  history?: unknown[]
  archiveRecord?(record: import('./observations.js').Observation | import('./observations.js').RepairPlan): Promise<void>
  archive?(receipt: BrokerReceipt, result: Readonly<ToolExecutionResult>): Promise<void>
}
export class BrokerError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'BrokerError' }
}
export function atPath(value: unknown, field: string): unknown {
  if (field === '$') return value
  let current = value
  for (const key of field.replace(/^\$\./, '').split('.')) {
    if (typeof current === 'string') { try { current = JSON.parse(current) } catch { return undefined } }
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
