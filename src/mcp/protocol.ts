import { z } from 'zod'
const id = z.string().min(1).max(512), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const wireOwnerSchema = z.object({
  hostInstanceId: z.string().uuid(), workspaceId: id, agentId: id, role: z.enum(['reason', 'explore', 'verify', 'writeup', 'main']),
  challengeId: id.optional(), taskId: id.optional(), runId: z.string().regex(/^r\d{3,}$/).optional(), sessionId: id.optional(),
}).strict().superRefine((o, ctx) => { if (o.role === 'main' ? !o.sessionId : !o.taskId || !o.runId || !o.challengeId) ctx.addIssue({ code: 'custom', message: 'owner 缺少其执行范围' }) })
export const wireResourceSchema = z.object({ backendId: id, resourceId: id, kind: z.enum(['ida-database', 'debug-process', 'remote-connection', 'browser-context', 'db-connection', 'stateless', 'generic']), generation: z.number().int().min(1) }).strict()
const validity = z.object({ scope: z.enum(['asset', 'environment', 'resource-epoch', 'state-revision']), assetDigests: z.array(digest).min(1).optional(), environmentDigest: digest.optional(), resource: wireResourceSchema.optional(), epoch: z.number().int().min(1).optional(), stateRevision: z.number().int().min(0).optional() }).strict().superRefine((v, ctx) => {
  if ((v.scope === 'asset' && !v.assetDigests) || (v.scope === 'environment' && (!v.assetDigests || !v.environmentDigest)) || (['resource-epoch', 'state-revision'].includes(v.scope) && (!v.resource || !v.epoch)) || (v.scope === 'state-revision' && v.stateRevision === undefined)) ctx.addIssue({ code: 'custom', message: '测量缺少有效范围' })
})
export const observationWireSchema = z.object({
  protocol: z.literal('sapper-mcp/1'), kind: z.literal('observation'), observationId: z.string().uuid(), owner: wireOwnerSchema,
  claim: z.string().min(1), value: z.json(), unit: z.string(), basis: z.enum(['tool-parsed', 'agent-inferred']), state: z.enum(['observed', 'inferred', 'stale']),
  receiptRefs: z.array(z.string().uuid()), validity, dependsOn: z.array(z.string().uuid()), createdAt: z.iso.datetime(),
}).strict().superRefine((v, ctx) => {
  if ((v.basis === 'tool-parsed' && (!v.receiptRefs.length || v.state === 'inferred')) || (v.basis === 'agent-inferred' && v.state === 'observed')) ctx.addIssue({ code: 'custom', message: '推断不能标为实测，实测需要成功回执' })
})
export const receiptWireSchema = z.object({
  protocol: z.literal('sapper-mcp/1'), kind: z.literal('receipt'), receiptId: z.string().uuid(), invocationId: z.string().uuid(), callId: id, owner: wireOwnerSchema,
  toolRef: z.object({ connectionRef: id, publicName: z.string().regex(/^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/), schemaDigest: digest }).strict(),
  argumentsDigest: digest, resultDigest: digest.optional(), resource: wireResourceSchema,
  target: z.object({ assetRefs: z.array(id), assetDigests: z.array(digest), binding: z.enum(['attested', 'unattested', 'not-applicable']), identities: z.array(z.object({ type: z.enum(['asset', 'endpoint', 'database', 'opaque']), value: id }).strict()).optional() }).strict(),
  fence: z.number().int().min(1), epoch: z.number().int().min(1), status: z.enum(['success', 'error', 'cancelled', 'delivery-unknown']), source: z.enum(['target', 'attachment', 'external-reference', 'unbound']),
  artifacts: z.array(z.object({ ref: id, digest, mediaType: id, bytes: z.number().int().min(0) }).strict()), startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), errorCode: id.optional(),
}).strict().superRefine((r, ctx) => {
  if ((r.status === 'success' && (!r.resultDigest || r.errorCode)) || (r.status !== 'success' && !r.errorCode)) ctx.addIssue({ code: 'custom', message: '回执状态与证据/错误不符' })
  if (r.target.binding === 'attested' && !r.target.assetDigests.length && !r.target.identities?.length) ctx.addIssue({ code: 'custom', message: '已认证目标必须有身份' })
})
