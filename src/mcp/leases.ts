import { randomUUID } from 'node:crypto'
import { BrokerError, type ResourceLease } from './contracts.js'
export interface ResourceRequest { key: string; backendId: string; capacity: number; exclusive?: boolean }
interface Waiter {
  id: string; ownerId: string; requests: ResourceRequest[]; since: string
  grant(leases: ResourceLease[]): void; reject(error: unknown): void; signal: AbortSignal; cleanup(): void
}
/** Atomic bundles, FIFO on conflicts, no nested hold-and-wait. No TTL stealing. */
export class LeaseScheduler {
  private leases = new Map<string, ResourceLease>()
  private pending: Waiter[] = []
  private fences = new Map<string, number>()
  private closed = false
  constructor(private changed: () => void = () => {}) {}
  counters() { return Object.fromEntries(this.fences) }
  restore(records: ResourceLease[], counters: Record<string, number> = {}) {
    for (const [key, value] of Object.entries(counters)) this.fences.set(key, Math.max(this.fences.get(key) ?? 0, value))
    for (const record of records) {
      this.fences.set(record.key, Math.max(this.fences.get(record.key) ?? 0, record.fence))
      if (record.state === 'released') continue
      this.leases.set(record.id, { ...record, state: 'quarantined', error: record.state === 'quarantined' && record.error ? record.error : '宿主重启，资源执行状态未核实' })
    }
  }
  snapshot() { return [...this.leases.values()].map((x) => ({ ...x })) }
  waiting() { return this.pending.map((w) => ({ id: w.id, ownerId: w.ownerId, keys: w.requests.map((r) => r.key), since: w.since })) }
  async acquire(ownerId: string, input: ResourceRequest[], signal: AbortSignal, waitMs: number): Promise<ResourceLease[]> {
    signal.throwIfAborted()
    if (this.closed) throw new BrokerError('LEASE_REVOKED', '工具资源协调器已关闭')
    const requests = [...new Map(input.map((r) => [r.key, r])).values()].sort((a, b) => a.key.localeCompare(b.key))
    if (!requests.length) return []
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { id: randomUUID(), ownerId, requests, since: new Date().toISOString(), signal, grant: resolve, reject, cleanup: () => {} }
      const remove = (reason: unknown) => {
        const index = this.pending.indexOf(waiter)
        if (index < 0) return
        this.pending.splice(index, 1); waiter.cleanup(); reject(reason); this.pump()
      }
      const abort = () => remove(signal.reason)
      const timer = waitMs > 0 ? setTimeout(() => remove(new BrokerError('RESOURCE_BUSY', '资源等待到期；结果已保留，可继续或选择其他路线')), waitMs) : undefined
      waiter.cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.push(waiter)
      if (signal.aborted) abort()
      else this.pump()
    })
  }
  private pump() {
    const blocked = new Set<string>()
    for (const waiter of [...this.pending]) {
      const quarantine = waiter.requests.map((r) => this.quarantineError(r)).find(Boolean)
      if (quarantine) {
        this.pending.splice(this.pending.indexOf(waiter), 1)
        waiter.cleanup()
        waiter.reject(quarantine)
        continue
      }
      const allocations = waiter.requests.map((r) => {
        const active = [...this.leases.values()].filter((l) => l.key === r.key && l.state !== 'released')
        const occupied = new Set(active.map((l) => l.slot))
        return { request: r, slot: active.length >= r.capacity || active.some((l) => l.exclusive) || (r.exclusive && active.length) ? undefined : Array.from({ length: r.capacity }, (_, n) => n).find((n) => !occupied.has(n)) }
      })
      if (allocations.some((a) => a.slot === undefined || blocked.has(a.request.key))) {
        waiter.requests.forEach((r) => blocked.add(r.key)); continue
      }
      this.pending.splice(this.pending.indexOf(waiter), 1); waiter.cleanup()
      const leases = allocations.map(({ request, slot }): ResourceLease => {
        const fence = (this.fences.get(request.key) ?? 0) + 1
        this.fences.set(request.key, fence)
        const now = new Date().toISOString()
        const lease: ResourceLease = { id: randomUUID(), ownerId: waiter.ownerId, key: request.key, backendId: request.backendId, slot: slot!, fence, epoch: fence, state: 'active', startedAt: now, heartbeatAt: now, assurance: 'serialized', ...(request.exclusive ? { exclusive: true } : {}) }
        this.leases.set(lease.id, lease); return lease
      })
      waiter.grant(leases)
    }
    this.changed()
  }
  quarantineError(request: ResourceRequest): BrokerError | undefined {
    const quarantined = [...this.leases.values()].filter((l) => l.key === request.key && l.state === 'quarantined')
    const first = quarantined[0]
    if (!first) return
    const blocksAllSlots = request.exclusive || quarantined.some((l) => l.exclusive) || quarantined.length >= request.capacity
    if (blocksAllSlots) return this.quarantinedError(first)
  }
  private quarantinedError(lease: ResourceLease) {
    const detail = lease.error ? ` ${lease.error}。` : ''
    return new BrokerError('RESOURCE_QUARANTINED', `${lease.key} 已隔离。${detail}核实旧操作已停止并重置实际后端后，在 设置 → Sapper → 工具与资源隔离 解除隔离。`)
  }
  active(lease: ResourceLease, cleanup = false) {
    if (this.leases.get(lease.id) === lease && lease.state === 'quarantined') {
      if (cleanup) return
      throw this.quarantinedError(lease)
    }
    if (this.leases.get(lease.id) !== lease || lease.state !== 'active') throw new BrokerError('LEASE_REVOKED', '资源租约不是当前活动租约')
  }
  heartbeat() { for (const lease of this.leases.values()) if (lease.state === 'active') lease.heartbeatAt = new Date().toISOString() }
  release(leases: ResourceLease[]) {
    for (const lease of leases) if (this.leases.get(lease.id) === lease && lease.state !== 'quarantined') lease.state = 'released'
    // Keep only bounded released diagnostics. Unreleased state must never be evicted.
    const old = [...this.leases.values()].filter((l) => l.state === 'released').slice(0, -128)
    for (const lease of old) this.leases.delete(lease.id)
    this.pump()
  }
  quarantine(lease: ResourceLease, error: string) { lease.state = 'quarantined'; lease.error = error; this.pump() }
  reset(key: string) {
    if (this.snapshot().some((l) => l.key === key && ['active', 'draining'].includes(l.state))) throw new BrokerError('RESOURCE_BUSY', '当前仍有活跃执行，不能解除隔离')
    for (const lease of this.leases.values()) if (lease.key === key && lease.state === 'quarantined') lease.state = 'released'
    this.pump()
  }
  cancelOwner(ownerId: string, reason: unknown) {
    for (const waiter of [...this.pending]) if (waiter.ownerId === ownerId) { this.pending.splice(this.pending.indexOf(waiter), 1); waiter.cleanup(); waiter.reject(reason) }
    this.pump()
  }
  close() {
    this.closed = true
    for (const waiter of this.pending.splice(0)) { waiter.cleanup(); waiter.reject(new BrokerError('LEASE_REVOKED', '工具协调器已关闭')) }
    this.changed()
  }
}
