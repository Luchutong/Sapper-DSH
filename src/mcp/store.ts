import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { brokerPolicySchema, type BrokerPolicy, type ResourceLease } from './contracts.js'
const initial = () => ({ policy: brokerPolicySchema.parse({}), revision: 1, fences: {} as Record<string, number>, leases: [] as ResourceLease[] })
const leaseSchema = z.object({ exclusive: z.boolean().optional(), id: z.string(), ownerId: z.string(), key: z.string(), slot: z.number().int(), backendId: z.string(), fence: z.number().int(), epoch: z.number().int(), state: z.enum(['active', 'draining', 'released', 'quarantined']), startedAt: z.string(), heartbeatAt: z.string(), assurance: z.enum(['serialized', 'process', 'verified-handle']), error: z.string().optional() })
const spec = defineDomain({ name: 'sapper_tool_broker', version: 1, global: { schema: z.object({ policy: brokerPolicySchema, revision: z.number().int().min(1), fences: z.record(z.string(), z.number().int().min(0)).default({}), leases: z.array(leaseSchema) }), initial: initial() }, tables: {} })
export class BrokerStore {
  private data = initial()
  private domain?: Domain<typeof spec>
  private chain: Promise<unknown> = Promise.resolve()
  durable = false
  ready: Promise<void> = Promise.resolve()
  constructor(ctx: Context, loaded: (leases: ResourceLease[], fences: Record<string, number>) => void) {
    ctx.inject(['storageDomain'], (scoped) => {
      this.ready = scoped.storageDomain.open(spec).then(async (domain) => {
        this.domain = domain
        this.data = structuredClone(domain.global.get())
        loaded(this.data.leases, this.data.fences)
        this.durable = true
        scoped.effect(() => () => domain.close())
      })
      this.ready.catch((e) => ctx.logger.warn('Sapper 工具层持久化加载失败：%s', (e as Error).message))
    })
  }
  snapshot() { return structuredClone(this.data) }
  private change(fn: (data: ReturnType<typeof initial>) => void) {
    const pending = this.chain.then(async () => {
      await this.ready
      const next = structuredClone(this.data)
      fn(next)
      if (this.domain) await this.domain.global.set(next)
      this.data = next
    })
    this.chain = pending.catch(() => {})
    return pending
  }
  configure(input: BrokerPolicy, revision: number) {
    const policy = brokerPolicySchema.parse(input)
    return this.change((data) => {
      if (revision !== data.revision) throw new Error('工具策略已被其他窗口修改，请刷新后保存')
      data.policy = policy; data.revision++
    })
  }
  saveLeases(leases: ResourceLease[], fences: Record<string, number>) { return this.change((data) => { data.leases = structuredClone(leases); data.fences = { ...fences } }) }
  async flush() { await this.ready; await this.chain }
}
