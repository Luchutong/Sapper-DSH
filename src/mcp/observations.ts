import { observationWireSchema } from './protocol.js'
import { randomUUID } from 'node:crypto'
import type { BrokerReceipt, ToolProfile } from './contracts.js'
import { atPath, BrokerError, capabilityId } from './contracts.js'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
export interface Observation {
  protocol: 'sapper-mcp/1'; kind: 'observation'; observationId: string; owner: BrokerReceipt['owner']; claim: string; value: unknown; unit: string
  basis: 'tool-parsed' | 'agent-inferred'; state: 'observed' | 'inferred' | 'stale'; receiptRefs: string[]; dependsOn: string[]; createdAt: string
  validity: { scope: 'asset' | 'resource-epoch' | 'state-revision'; assetDigests?: string[]; resource?: BrokerReceipt['resource']; epoch?: number; stateRevision?: number }
}
export interface RepairPlan {
  protocol: 'sapper-mcp/1'; kind: 'repair-plan'; planId: string; owner: BrokerReceipt['owner']; failureReceiptRefs: string[]
  preserve: string[]; invalidate: string[]; resumeFrom: 'current-state' | 'last-safe-checkpoint' | 'fresh-resource'; replaySafeStepRefs: string[]; nextCapability: string; reason: string; createdAt: string
}
/** Immutable observations. Current validity is projected; historical records are never rewritten. */
export class ObservationLedger {
  private values = new Map<string, Observation>()
  private invalid = new Set<string>()
  private historical = new Set<string>()
  plans: RepairPlan[] = []
  load(value: unknown) {
    // Disk is history/untrusted data, never a newly minted tool measurement.
    const parsed = observationWireSchema.safeParse(value)
    if (!parsed.success) return
    const v = parsed.data as Observation
    if (!this.values.has(v.observationId)) { this.values.set(v.observationId, structuredClone(v)); this.historical.add(v.observationId) }
  }
  record(receipt: BrokerReceipt, result: Readonly<ToolExecutionResult>, profile?: ToolProfile): Observation[] {
    if (result.isError || receipt.status !== 'success') return []
    const out: Observation[] = []
    for (const rule of profile?.measurements ?? []) {
      if (rule.tool !== receipt.toolRef.publicName) continue
      const value = atPath(result.value, rule.valuePath)
      if (value === undefined) continue
      const digest = rule.assetDigestPath ? atPath(result.value, rule.assetDigestPath) : undefined
      const asset = typeof digest === 'string' && /^(sha256:)?[a-f0-9]{64}$/.test(digest) ? digest.startsWith('sha256:') ? digest : 'sha256:' + digest : undefined
      if (rule.validity === 'asset' && !asset) continue
      const observation: Observation = { protocol: 'sapper-mcp/1', kind: 'observation', observationId: randomUUID(), owner: receipt.owner, claim: rule.claim, value, unit: rule.unit, basis: 'tool-parsed', state: 'observed', receiptRefs: [receipt.receiptId], dependsOn: [], createdAt: receipt.endedAt,
        validity: rule.validity === 'asset' ? { scope: 'asset', assetDigests: [asset!] } : { scope: rule.validity, resource: receipt.resource, epoch: receipt.epoch, ...(rule.validity === 'state-revision' ? { stateRevision: receipt.epoch } : {}) } }
      this.values.set(observation.observationId, observation); out.push(observation)
    }
    return out
  }
  infer(receipt: BrokerReceipt, claim: string, value: unknown): Observation {
    if (receipt.status !== 'success') throw new BrokerError('TOOL_ERROR', '推断也必须引用成功回执')
    const observation: Observation = { protocol: 'sapper-mcp/1', kind: 'observation', observationId: randomUUID(), owner: receipt.owner, claim, value, unit: '', basis: 'agent-inferred', state: 'inferred', receiptRefs: [receipt.receiptId], dependsOn: [], createdAt: new Date().toISOString(), validity: { scope: 'resource-epoch', resource: receipt.resource, epoch: receipt.epoch } }
    this.values.set(observation.observationId, observation); return observation
  }
  list(current: Array<{ backendId: string; resourceId: string; generation: number; epoch: number }>, assets: string[] = []) {
    return [...this.values.values()].map((value) => {
      const v = value.validity
      const valid = !this.historical.has(value.observationId) && !this.invalid.has(value.observationId) && value.basis === 'tool-parsed' &&
        (v.scope === 'asset' ? !!v.assetDigests?.every((d) => assets.includes(d)) : current.some((r) => r.backendId === v.resource?.backendId && r.resourceId === v.resource?.resourceId && r.generation === v.resource.generation && r.epoch === v.epoch))
      return { ...structuredClone(value), currentlyApplicable: valid, ...(valid || value.basis === 'agent-inferred' ? {} : { invalidReason: this.historical.has(value.observationId) ? '历史磁盘记录仅作参考；需轻量重新取证' : '目标、资源版本或恢复计划已改变' }) }
    })
  }
  require(ids: string[], current: Array<{ backendId: string; resourceId: string; generation: number; epoch: number }>, assets: string[] = []) {
    const list = this.list(current, assets)
    for (const id of ids) if (!list.some((v) => v.observationId === id && v.currentlyApplicable)) throw new BrokerError('STALE_EPOCH', '声明的前提测量已缺失或失效：' + id)
  }
  diagnose(receipt: BrokerReceipt, input: { preserve: string[]; invalidate: string[]; resumeFrom: RepairPlan['resumeFrom']; nextCapability: string; reason: string }): RepairPlan {
    if (receipt.status === 'success') throw new BrokerError('TOOL_ERROR', '诊断需引用实际失败回执')
    if (input.preserve.some((id) => input.invalidate.includes(id))) throw new BrokerError('TOOL_ERROR', '保留与失效集合不能相交')
    for (const id of [...input.preserve, ...input.invalidate]) if (!this.values.has(id)) throw new BrokerError('TOOL_ERROR', '未知观察 ID：' + id)
    const plan: RepairPlan = { protocol: 'sapper-mcp/1', kind: 'repair-plan', planId: randomUUID(), owner: receipt.owner, failureReceiptRefs: [receipt.receiptId], preserve: input.preserve, invalidate: input.invalidate, resumeFrom: input.resumeFrom, replaySafeStepRefs: [], nextCapability: capabilityId.parse(input.nextCapability), reason: input.reason, createdAt: new Date().toISOString() }
    input.invalidate.forEach((id) => this.invalid.add(id)); this.plans.push(plan)
    return plan
  }
}
