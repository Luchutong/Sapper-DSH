import { describe, expect, it, vi } from 'vitest'
import { LeaseScheduler } from '../src/mcp/leases.js'
import { brokerPolicySchema, type BrokerOwner } from '../src/mcp/contracts.js'
import { routeTool } from '../src/mcp/router.js'
const owner: BrokerOwner = { hostInstanceId: 'host', workspaceId: 'A', taskId: 't-A', runId: 'r001', agentId: 'agent-A', role: 'explore', cwd: '/A' }
const signal = () => new AbortController().signal
const resource = (key: string, capacity = 1, exclusive = false) => ({ key, backendId: key, capacity, exclusive })

describe('MCP resource coordination', () => {
  it('atomically allocates bundles and allows unrelated work past a blocked bundle', async () => {
    const s = new LeaseScheduler()
    const held = await s.acquire('one', [resource('A')], signal(), 1000)
    const next = s.acquire('two', [resource('B'), resource('A')], signal(), 1000)
    expect(s.snapshot().filter((l) => l.ownerId === 'two')).toEqual([])
    const independent = await s.acquire('three', [resource('C')], signal(), 1000)
    s.release(held)
    expect((await next).map((l) => l.key)).toEqual(['A', 'B'])
    s.release(independent); s.close()
  })
  it('prevents a writer overlapping existing or newly arriving parallel readers', async () => {
    const s = new LeaseScheduler(), read = resource('DB', 3), write = resource('DB', 3, true)
    const r1 = await s.acquire('reader1', [read], signal(), 1000)
    const r2 = await s.acquire('reader2', [read], signal(), 1000)
    const writer = s.acquire('writer', [write], signal(), 1000)
    const r3 = s.acquire('reader3', [read], signal(), 1000)
    s.release(r1); expect(s.waiting().map((w) => w.ownerId)).toEqual(['writer', 'reader3'])
    s.release(r2); const w = await writer
    expect(s.waiting().map((x) => x.ownerId)).toEqual(['reader3'])
    s.release(w); s.release(await r3); s.close()
  })
  it('does not steal an expired heartbeat, removes canceled waiters, and requires reset after quarantine', async () => {
    const s = new LeaseScheduler(), first = await s.acquire('first', [resource('IDA')], signal(), 1000)
    first[0]!.heartbeatAt = '2000-01-01T00:00:00Z'
    const cancel = new AbortController(), wait = s.acquire('second', [resource('IDA')], cancel.signal, 1000)
    const rejected = expect(wait).rejects.toThrow('cancelled')
    cancel.abort(new Error('cancelled')); await rejected
    expect(s.snapshot().find((x) => x.id === first[0]!.id)?.state).toBe('active')
    s.quarantine(first[0]!, 'remote unknown'); s.release(first)
    expect(s.snapshot()[0]?.state).toBe('quarantined')
    await expect(s.acquire('third', [resource('IDA')], signal(), 0)).rejects.toThrow('RESOURCE_QUARANTINED')
    s.reset('IDA'); const last = await s.acquire('third', [resource('IDA')], signal(), 1000)
    expect(last[0]!.fence).toBeGreaterThan(first[0]!.fence)
    s.release(last); s.close()
  })
  it('restores prior active work as quarantined without replay or reusing its fence', async () => {
    const prior = new LeaseScheduler(), old = await prior.acquire('old', [resource('IDA')], signal(), 1000)
    const next = new LeaseScheduler(); next.restore(prior.snapshot())
    expect(next.snapshot()[0]?.state).toBe('quarantined')
    next.reset('IDA')
    const lease = await next.acquire('new', [resource('IDA')], signal(), 1000)
    expect(lease[0]!.fence).toBeGreaterThan(old[0]!.fence)
    prior.close(); next.close()
  })
  it('times out a waiter without manufacturing a lease or disturbing the holder', async () => {
    vi.useFakeTimers()
    try {
      const s = new LeaseScheduler(), first = await s.acquire('holder', [resource('IDA')], signal(), 1000)
      const wait = s.acquire('waiter', [resource('IDA')], signal(), 500)
      const rejected = expect(wait).rejects.toThrow('RESOURCE_BUSY')
      await vi.advanceTimersByTimeAsync(501); await rejected
      expect(s.waiting()).toEqual([]); expect(s.snapshot().filter((x) => x.state === 'active')).toEqual(first)
      s.release(first); s.close()
    } finally { vi.useRealTimers() }
  })
})
describe('MCP capability routing', () => {
  const policy = brokerPolicySchema.parse({ profiles: [
    { id: 'ida', label: 'IDA', backendId: 'shared-IDA', selectors: ['mcp__ida__*', 'mcp__ida_alias__*'], capabilities: ['binary.decompile'], workspaceIds: ['A'], roles: ['explore'] },
    { id: 'browser', label: 'Browser', backendId: 'browser', selectors: ['mcp__browser__*'], capabilities: ['web.browser'] },
  ] })
  it('keeps workspace, role, requested capabilities and aliases separate from wildcard visibility', () => {
    const route = (name: string, who = owner, requested: string[] = []) => routeTool(name, who, policy, requested, 'binary analysis', () => false)
    expect(route('mcp__ida__decompile').profile?.backendId).toBe('shared-IDA')
    expect(route('mcp__ida_alias__decompile').profile?.backendId).toBe('shared-IDA')
    expect(route('mcp__ida__decompile', { ...owner, workspaceId: 'B' }).allowed).toBe(false)
    expect(route('mcp__ida__decompile', { ...owner, role: 'verify' }).allowed).toBe(false)
    expect(route('mcp__browser__navigate', owner, ['binary.decompile']).allowed).toBe(false)
    expect(route('mcp__browser__navigate', owner, ['web.browser']).allowed).toBe(true)
  })
  it('rejects contradictory alias capacity and does not infer isolation from arbitrary tool descriptions', () => {
    expect(() => brokerPolicySchema.parse({ profiles: [policy.profiles[0], { ...policy.profiles[0], id: 'alias', maxInFlight: 4 }] })).toThrow('容量必须一致')
    expect(routeTool('mcp__unknown__read_only', owner, policy, [], '', () => false).profile).toBeUndefined()
    expect(() => brokerPolicySchema.parse({ profiles: [{ id: 'worker', label: 'Worker', backendId: 'worker', selectors: ['mcp__ida__*'], isolation: 'dedicated-instance' }] })).toThrow('提供者')
  })
})
