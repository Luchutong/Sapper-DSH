import { receiptWireSchema } from './protocol.js'
import { nativeHandleProvider } from './adapters/native-handle.js'
import { ObservationLedger } from './observations.js'
import { InteractiveSessions } from './adapters/interactive.js'
import { interactionRequestSchema } from './adapters/interactive-schema.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult, ToolDispatchExecution, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BrokerError, atPath, type BrokerOwner, type BrokerReceipt, type BrokerSnapshot, type ManagedContext, type ResourceInstance, type ResourceProvider, type Selection, type ToolProfile } from './contracts.js'
import { BrokerStore } from './store.js'
import { LeaseScheduler } from './leases.js'
import type { ResourceRequest } from './leases.js'
import { mcpTool, resourceKey, routeTool } from './router.js'
import { EXPLORE_TOOLS, matchesTool } from '../orchestration/tool-policy.js'
import type { ResourceLease } from './contracts.js'

declare module '@deepseek-ai/cordis' { interface Context { sapperToolBroker: ToolBroker } }
interface SessionBinding {
  context: ManagedContext; policy: ReturnType<BrokerStore['snapshot']>; selection: Selection
  profiles: Map<string, ToolProfile | undefined>; leases: ResourceLease[]; instances: Map<string, ResourceInstance>
  ledger: ObservationLedger; calls: Set<Promise<unknown>>; receipts: BrokerReceipt[]; saves: Promise<void>; refresh: boolean; closed: boolean; activated: boolean
}
interface ExecutionBinding {
  session: SessionBinding; lease: ResourceLease; profile?: ToolProfile | undefined; instance?: ResourceInstance | undefined
  schemaDigest: string; invocationId: string; startedAt: string; temporary: boolean; target: BrokerReceipt['target']
  slots: ResourceLease[]; released: boolean; bodyEntered: boolean; definition: ToolDefinition
}
const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

/** One root service for all workspaces, including native main-session MCP calls. */
export class ToolBroker extends Service {
  readonly hostInstanceId = randomUUID()
  readonly store: BrokerStore
  readonly scheduler: LeaseScheduler
  private calls = new WeakMap<ToolExecution, ExecutionBinding>()
  private internal = new AsyncLocalStorage<{ callId: string; agent: Agent; name: string; digest: string; purpose: 'identity' | 'business' | 'cleanup' }>()
  private verifying = new AsyncLocalStorage<boolean>()
  private internalKinds = new WeakMap<ToolExecution, 'identity' | 'business' | 'cleanup'>()
  private ledgers = new Map<string, ObservationLedger>()
  private sessions = new Map<string, SessionBinding>()
  private providers = new Map<string, ResourceProvider>()
  private interactions: InteractiveSessions
  private diagnostics: BrokerReceipt[] = []
  private slots = new LeaseScheduler()
  private closed = false
  private policyUpdates: Promise<unknown> = Promise.resolve()
  private persistence: Promise<void> = Promise.resolve()
  private persistenceError?: string
  constructor(ctx: Context, private enabled: () => boolean = () => true) {
    super(ctx, 'sapperToolBroker')
    this.interactions = new InteractiveSessions((agent, name, args, signal) => this.invoke(agent, name, args, signal, 'business'))
    this.providers.set('native-handle', nativeHandleProvider((agent, name, args, signal, purpose) => this.invoke(agent, name, args, signal, purpose)))
    this.scheduler = new LeaseScheduler(() => {})
    this.store = new BrokerStore(ctx, (leases, fences) => this.scheduler.restore(leases, fences))
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!mcpTool(exec.name) || this.passive()) return next()
      const ticket = this.internal.getStore()
      if (ticket && ticket.agent === exec.agent && ticket.callId === String(exec.callId) && ticket.name === exec.name && ticket.digest === hash(exec.arguments)) this.internalKinds.set(exec, ticket.purpose)
      if (this.internalKinds.get(exec) === 'identity') {
        const session = this.sessions.get(String(exec.agent?.id)), profile = session?.profiles.get(exec.name)
        const lease = session?.leases.find((l) => l.key === resourceKey(profile)), definition = this.ctx.tools.get(exec.name, exec.agent)
        if (session && lease && definition) this.calls.set(exec, { session, lease, profile, instance: session.instances.get(lease.key), schemaDigest: hash({ name: definition.name, description: definition.description, parameters: definition.parameters }), invocationId: randomUUID(), startedAt: new Date().toISOString(), temporary: false, target: { assetRefs: [], assetDigests: [], binding: 'unattested' }, slots: [], released: false, bodyEntered: false, definition })
        return next()
      }
      if (this.verifying.getStore()) throw new BrokerError('ADAPTER_UNAVAILABLE', '提供者 verify 必须使用传入的原生 invoke，不能递归执行受管工具')
      try {
        await this.reserve(exec)
        const decision = await next()
        if (decision.kind !== 'allow') this.releaseCall(exec)
        return decision
      } catch (error) { this.releaseCall(exec); throw error }
    })
    ctx.tools.guard((exec) => {
      if (!mcpTool(exec.name)) return
      const ticket = this.internal.getStore()
      if (ticket && ticket.agent === exec.agent && ticket.callId === String(exec.callId) && ticket.name === exec.name && ticket.digest === hash(exec.arguments)) this.internalKinds.set(exec, ticket.purpose)
      const session = this.sessions.get(String(exec.agent?.id))
      if (!session) return
      try { this.check(session, exec.name, exec.agent, this.isCleanupCall(exec)); this.checkArguments(session, exec) }
      catch (error) { return errorText(error) }
    })
    ctx.on('tools/execute', async (exec, next) => {
      if (!mcpTool(exec.name) || this.passive()) return next()
      return this.execute(exec, next)
    })
    ctx.on('tools/result', (exec, result) => { try { this.record(exec, result) } finally { this.releaseCall(exec) } return undefined })
    const heartbeat = setInterval(() => { this.scheduler.heartbeat(); void this.persist().catch(() => {}) }, 15000)
    heartbeat.unref()
    ctx.effect(() => async () => {
      this.closed = true; clearInterval(heartbeat); this.scheduler.close(); this.slots.close()
      await Promise.allSettled([...this.sessions.keys()].map((id) => this.finish(id)))
      await this.persist().catch(() => {})
    })
  }
  private passive() { return !this.enabled() && !this.sessions.size && !this.scheduler.snapshot().some((l) => l.state !== 'released') }
  registerProvider(id: string, provider: ResourceProvider): () => void {
    if (this.providers.has(id)) throw new Error('资源提供者已注册：' + id)
    this.providers.set(id, provider)
    return () => { if (this.providers.get(id) === provider) this.providers.delete(id) }
  }
  isCleanupCall(exec: Readonly<ToolExecution>) {
    const ticket = this.internal.getStore()
    const cleanup = ticket?.purpose === 'cleanup' && ticket.agent === exec.agent && ticket.callId === String(exec.callId) && ticket.name === exec.name && ticket.digest === hash(exec.arguments)
    return cleanup || this.internalKinds.get(exec) === 'cleanup'
  }
  isIdentityCall(exec: Readonly<ToolExecution>) { return this.internalKinds.get(exec) === 'identity' }
  receipt(exec: Readonly<ToolExecution>) { return [...this.diagnostics].reverse().find((r) => r.callId === String(exec.callId) && r.owner.agentId === String(exec.agent?.id)) }
  private persist() {
    const snapshot = this.scheduler.snapshot()
    const pending = this.persistence.then(() => this.store.saveLeases(snapshot, this.scheduler.counters()))
    this.persistence = pending.catch((e) => { this.persistenceError = errorText(e) })
    return pending
  }
  configure(input: Parameters<BrokerStore['configure']>[0], revision: number) {
    const next = this.policyUpdates.then(async () => {
      await this.store.ready
      const mapping = (policy: Parameters<BrokerStore['configure']>[0]) => JSON.stringify(policy.profiles.map((p) => ({ id: p.id, backendId: p.backendId, selectors: [...p.selectors].sort(), isolation: p.isolation, providerId: p.providerId })).sort((a, b) => a.id.localeCompare(b.id)))
      if (mapping(input) !== mapping(this.store.snapshot().policy) && this.scheduler.snapshot().some((l) => l.state !== 'released')) throw new BrokerError('RESOURCE_BUSY', '资源仍被占用或隔离，不能改变后端映射/隔离方式；先结束任务并核实资源，角色与工作区范围仍可收紧')
      await this.store.configure(input, revision); return this.snapshot()
    })
    this.policyUpdates = next.catch(() => {})
    return next
  }
  snapshot(): BrokerSnapshot {
    const { policy, revision } = this.store.snapshot()
    return { policy, revision, durable: this.store.durable, hostInstanceId: this.hostInstanceId, leases: this.scheduler.snapshot(), waiting: this.scheduler.waiting(), providers: [...this.providers.keys()], owners: [...this.sessions.values()].map((s) => ({ ...s.context.owner })), receipts: structuredClone(this.diagnostics), warnings: [
      '仅协调当前 DSH 宿主中经过 ToolRuntime 的调用；外部脚本、其他 DSH 进程和 shell 直连不受此锁保护。',
      ...(!this.store.durable ? ['资源状态尚未持久化；请勿据此声称重启后的强隔离。'] : []),
      ...(this.persistenceError ? ['资源持久化失败：' + this.persistenceError] : []),
    ] }
  }
  async reset(key: string, confirmed: boolean) {
    if (!confirmed) throw new BrokerError('RESOURCE_QUARANTINED', '必须先确认实际后端已重置/旧操作已停止')
    this.scheduler.reset(key); await this.persist(); return this.snapshot()
  }
  private owner(agent: Agent): BrokerOwner {
    const cwd = agent.session.header.cwd ?? ''
    const workspace = this.ctx.get('workspaceRegistry')?.list().find((w) => w.path === cwd)
    return { hostInstanceId: this.hostInstanceId, workspaceId: workspace ? String(workspace.id) : 'session:' + String(agent.id), taskId: '', runId: '', agentId: String(agent.id), role: 'main', cwd }
  }
  async activate(agent: Agent) {
    const session = this.sessions.get(String(agent.id))
    if (!session || session.activated) return
    for (const instance of session.instances.values()) if (!await this.verifying.run(true, () => instance.verify(agent, session.context.signal, (name, args) => this.invoke(agent, name, args, session.context.signal, 'identity')))) throw new BrokerError('TARGET_MISMATCH', '资源实例目标身份不符')
    session.activated = true
  }
  async prepare(context: ManagedContext) {
    await this.store.ready
    context.signal.throwIfAborted(); context.guard()
    if (this.closed) throw new BrokerError('LEASE_REVOKED', '工具层已关闭')
    if (this.sessions.has(context.owner.agentId)) throw new BrokerError('RESOURCE_BUSY', '子代理资源已绑定')
    const policy = this.store.snapshot()
    const session: SessionBinding = { context, policy, selection: { revision: policy.revision, selected: [], excluded: [], requiredCapabilities: context.requested, missingCapabilities: [] }, profiles: new Map(), leases: [], instances: new Map(), ledger: new ObservationLedger(), calls: new Set(), receipts: [], saves: Promise.resolve(), refresh: false, closed: false, activated: false }
    const key = context.owner.workspaceId + ':' + context.owner.taskId
    session.ledger = this.ledgers.get(key) ?? new ObservationLedger()
    for (const record of context.history ?? []) session.ledger.load(record)
    this.ledgers.set(key, session.ledger)
    this.sessions.set(context.owner.agentId, session)
    try { if (context.owner.role !== 'reason') await this.allocate(session) }
    catch (error) { await this.finish(context.owner.agentId); throw error }
    return structuredClone(session.selection)
  }
  private select(session: SessionBinding) {
    const { context, policy } = session
    session.profiles.clear()
    const selection: Selection = { revision: policy.revision, selected: [], excluded: [], requiredCapabilities: [...context.requested], missingCapabilities: [] }
    const capabilities = new Set<string>()
    for (const tool of this.ctx.tools.schemas(context.parent)) {
      if (!mcpTool(tool.name) || !matchesTool(context.selectors, tool.name)) continue
      const route = routeTool(tool.name, context.owner, policy.policy, context.requested, context.text, (id) => this.providers.has(id))
      if (!route.allowed) { selection.excluded.push({ name: tool.name, reason: route.reason }); continue }
      selection.selected.push(tool.name); session.profiles.set(tool.name, route.profile)
      for (const cap of route.profile?.capabilities ?? []) capabilities.add(cap)
    }
    if (policy.policy.selection === 'auto') {
      const groups = new Map<string, ToolProfile[]>()
      for (const profile of new Set(session.profiles.values())) if (profile?.capabilities.length) {
        const key = [...profile.capabilities].sort().join(',')
        groups.set(key, [...(groups.get(key) ?? []), profile])
      }
      for (const profiles of groups.values()) if (new Set(profiles.map((p) => p.backendId)).size > 1) {
        const load = (p: ToolProfile) => this.scheduler.snapshot().filter((l) => l.backendId === p.backendId && l.state !== 'released').length / (['dedicated-instance', 'explicit-handle'].includes(p.isolation) ? p.maxInstances : 1)
        const chosen = [...profiles].sort((a, b) => load(a) - load(b) || a.id.localeCompare(b.id))[0]!
        for (const [name, profile] of session.profiles) if (profile && profiles.includes(profile) && profile.backendId !== chosen.backendId) {
          session.profiles.delete(name); selection.selected = selection.selected.filter((n) => n !== name)
          selection.excluded.push({ name, reason: '同类能力选用了负载较低的后端 ' + chosen.backendId })
        }
      }
    }
    selection.missingCapabilities = context.requested.filter((c) => ![...capabilities].some((p) => p === c || p.startsWith(c + '.') || c.startsWith(p + '.')))
    session.selection = selection
  }
  private async allocate(session: SessionBinding) {
    await this.policyUpdates
    session.policy = this.store.snapshot()
    this.select(session)
    session.activated = false
    const requests: ResourceRequest[] = []
    for (const profile of session.profiles.values()) if (profile?.isolation !== 'stateless') requests.push({ key: resourceKey(profile), backendId: profile?.backendId ?? 'unclassified:mcp', capacity: profile && ['dedicated-instance', 'explicit-handle'].includes(profile.isolation) ? profile.maxInstances : 1, exclusive: !profile || profile.isolation === 'exclusive-workflow' })
    const pending = this.scheduler.acquire(session.context.owner.agentId, requests, session.context.signal, 0)
    void pending.catch(() => {})
    if (this.scheduler.waiting().some((w) => w.ownerId === session.context.owner.agentId)) await session.context.progress('resource-waiting')
    session.leases = await pending
    await this.persist()
    await session.context.progress('resources-ready')
  }
  async provision(agentId: string) {
    const session = this.sessions.get(agentId)
    if (!session) return
    for (const lease of session.leases) {
      if (session.instances.has(lease.key)) continue
      const profile = [...session.profiles.values()].find((p) => resourceKey(p) === lease.key)
      if (!profile?.providerId) continue
      const provider = this.providers.get(profile.providerId)
      if (!provider) throw new BrokerError('ADAPTER_UNAVAILABLE', '实例提供者已退出')
      let instance: ResourceInstance
      try { instance = await provider.open({ profile, owner: session.context.owner, slot: lease.slot, fence: lease.fence, signal: session.context.signal }) }
      catch (error) { this.scheduler.quarantine(lease, '实例创建未确认完成：' + errorText(error)); throw error }
      session.instances.set(lease.key, instance)
      if (!instance.tools.length || !instance.tools.every((name) => mcpTool(name) && matchesTool(session.context.selectors, name) && this.ctx.tools.get(name, session.context.parent)))
        throw new BrokerError('SCOPE_DENIED', '实例工具未注册或不在父会话/角色范围内')
      for (const [name, p] of [...session.profiles]) if (p?.backendId === profile.backendId) { session.profiles.delete(name); session.selection.selected = session.selection.selected.filter((n) => n !== name) }
      for (const name of instance.tools) { session.profiles.set(name, profile); session.selection.selected.push(name) }
      lease.assurance = instance.assurance
    }
  }
  selection(agentId: string) { const s = this.sessions.get(agentId); return s ? structuredClone(s.selection) : undefined }
  allowed(agentId: string, name: string) {
    const session = this.sessions.get(agentId)
    if (!session || session.closed) return false
    if (!session.profiles.has(name)) {
      // Newly registered tools in an already-reserved domain can appear at a later boundary.
      const route = routeTool(name, session.context.owner, session.policy.policy, session.context.requested, session.context.text, (id) => this.providers.has(id))
      if (!route.allowed || route.profile?.providerId || !this.ctx.tools.get(name, session.context.parent) || !matchesTool(session.context.selectors, name)) return false
      if (route.profile?.isolation !== 'stateless' && !session.leases.some((l) => l.key === resourceKey(route.profile))) return false
      session.profiles.set(name, route.profile); session.selection.selected.push(name)
    }
    try { this.check(session, name); return true } catch { return false }
  }
  private check(session: SessionBinding, name: string, agent?: Agent, cleanup = false) {
    if (!cleanup) session.context.signal.throwIfAborted()
    session.context.guard()
    if (this.closed || (session.closed && !cleanup)) throw new BrokerError('LEASE_REVOKED', '资源工作流已关闭')
    if (!session.profiles.has(name) || !matchesTool(session.context.selectors, name) || !this.ctx.tools.get(name, session.context.parent)) throw new BrokerError('SCOPE_DENIED', '工具不在当前工作流或父会话范围')
    if (agent && !this.ctx.tools.get(name, agent)) throw new BrokerError('SCOPE_DENIED', '连接器未向当前 Agent 激活该工具')
    const old = session.profiles.get(name)
    const current = this.store.snapshot()
    const live = old && current.policy.profiles.find((p) => p.id === old.id)
    if (old && (!live || live.backendId !== old.backendId || live.isolation !== old.isolation || live.providerId !== old.providerId)) throw new BrokerError('LEASE_REVOKED', '该资源映射已变更，请在下一阶段重新绑定')
    if (live && !cleanup && ((live.workspaceIds.length && !live.workspaceIds.includes(session.context.owner.workspaceId)) || (session.context.owner.role !== 'main' && session.context.owner.role !== 'reason' && !live.roles.includes(session.context.owner.role)))) throw new BrokerError('SCOPE_DENIED', '该资源的工作区/角色使用权限已撤销')
    if (!old && current.policy.profiles.some((p) => matchesTool(p.selectors, name))) throw new BrokerError('LEASE_REVOKED', '工具已分类，请在下一阶段重新绑定')
    if (!cleanup && old?.providerId && !this.providers.has(old.providerId)) throw new BrokerError('ADAPTER_UNAVAILABLE', '资源提供者已退出')
  }
  private checkArguments(session: SessionBinding, exec: Readonly<ToolExecution>) {
    const profile = session.profiles.get(exec.name)
    const privateCall = this.internalKinds.has(exec) || this.isCleanupCall(exec)
    const lifecycle = session.instances.get(resourceKey(profile))?.lifecycleTools ?? []
    if (lifecycle.includes(exec.name) && !privateCall) throw new BrokerError('SCOPE_DENIED', '资源创建/关闭工具由宿主统一管理')
    if (privateCall) return
    for (const [key, expected] of Object.entries(profile?.bindings[exec.name] ?? {})) if (atPath(exec.arguments, key) !== expected.replaceAll('{{cwd}}', session.context.owner.cwd).replaceAll('{{taskId}}', session.context.owner.taskId)) throw new BrokerError('TARGET_MISMATCH', '调用参数越过已配置目标绑定：' + key)
    if (profile?.handleArgument && atPath(exec.arguments, profile.handleArgument) !== undefined) {
      const handle = atPath(exec.arguments, profile.handleArgument)
      if (!this.interactions.ownedHandles(session.context.owner.agentId).some((h) => h.profileId === profile.id && h.handle === handle)) throw new BrokerError('TARGET_MISMATCH', '交互句柄不属于当前工作流')
    }
    const instance = session.instances.get(resourceKey(profile))
    for (const [key, value] of Object.entries(instance?.bindings ?? {})) if (atPath(exec.arguments, key) !== value) throw new BrokerError('TARGET_MISMATCH', '原生工具参数未绑定本工作流资源：' + key)
  }
  async yieldForCapacity(agentId: string) {
    const session = this.sessions.get(agentId)
    if (!session || !session.leases.length) return false
    await this.drain(session); await this.release(session); session.refresh = true
    return true
  }
  async refresh(agentId: string) {
    const session = this.sessions.get(agentId)
    if (!session) return
    if (!session.refresh) {
      session.refresh = this.ctx.tools.schemas(session.context.parent).some((t) => {
        if (!mcpTool(t.name) || session.profiles.has(t.name) || !matchesTool(session.context.selectors, t.name)) return false
        const route = routeTool(t.name, session.context.owner, session.policy.policy, session.context.requested, session.context.text, (id) => this.providers.has(id))
        return route.allowed && route.profile?.isolation !== 'stateless' && !session.leases.some((l) => l.key === resourceKey(route.profile))
      })
    }
    if (!session.refresh) return
    await this.drain(session)
    await this.release(session)
    session.policy = this.store.snapshot(); session.refresh = false
    await this.allocate(session)
  }
  request(agentId: string, requested: string[]) {
    const session = this.sessions.get(agentId)
    if (!session || session.context.owner.role === 'reason') throw new BrokerError('SCOPE_DENIED', '仅探索/复核工作流可以申请新能力')
    session.context.requested = [...new Set([...session.context.requested, ...requested])]; session.refresh = true
    return { pending: true, message: '将在下一推理边界排空并重新申请资源；不改变父会话或连接器授权' }
  }
  private async invoke(agent: Agent, name: string, args: unknown, signal: AbortSignal, purpose: 'identity' | 'business' | 'cleanup') {
    if (!this.ctx.tools.get(name, agent)) throw new BrokerError('SCOPE_DENIED', '资源校验工具在当前 Agent 不可见')
    const callId = ToolCallId('sapper-broker-' + randomUUID())
    return this.internal.run({ callId: String(callId), agent, name, digest: hash(args), purpose }, () => this.ctx.tools.execute({ agent, name, arguments: args, callId, signal }))
  }
  private async target(binding: ExecutionBinding, exec: Readonly<ToolExecution>) {
    const { profile, instance, session } = binding
    if (instance) {
      if (!exec.agent || !await this.verifying.run(true, () => instance.verify(exec.agent!, exec.signal, (name, args) => this.invoke(exec.agent!, name, args, exec.signal, 'identity')))) throw new BrokerError('TARGET_MISMATCH', '实例提供者未能核对当前资源身份')
      return { assetRefs: [], assetDigests: instance.assetDigests ?? [], binding: 'attested' as const, identities: [{ type: 'opaque' as const, value: instance.resourceId }] }
    }
    if (profile?.identity && exec.agent) {
      const probe = profile.identity
      if (!session.profiles.has(probe.tool)) throw new BrokerError('SCOPE_DENIED', '目标校验工具不在本工作流的角色范围')
      const result = await this.invoke(exec.agent, probe.tool, probe.arguments, exec.signal, 'identity')
      const expected = probe.expected.replaceAll('{{cwd}}', session.context.owner.cwd).replaceAll('{{taskId}}', session.context.owner.taskId)
      if (result.isError || atPath(result.value, probe.resultPath) !== expected) throw new BrokerError('TARGET_MISMATCH', '服务实际目标与资源配置不一致')
      return { assetRefs: [], assetDigests: /^(sha256:)?[a-f0-9]{64}$/.test(expected) ? [expected.startsWith('sha256:') ? expected : 'sha256:' + expected] : [], binding: 'attested' as const, identities: [{ type: 'opaque' as const, value: hash(expected) }] }
    }
    return { assetRefs: [], assetDigests: [], binding: 'unattested' as const }
  }
  private async reserve(exec: Readonly<ToolExecution>) {
    await this.policyUpdates
    await this.store.ready
    if (this.closed || !exec.agent) throw new BrokerError('SCOPE_DENIED', 'MCP 资源调用需要实际 Agent 身份与可用工具层')
    const definition = this.ctx.tools.get(exec.name, exec.agent)
    if (!definition) throw new BrokerError('SCOPE_DENIED', '当前 Agent 未被授予该原生工具')
    let session = this.sessions.get(String(exec.agent.id)), temporary = false
    if (!session) {
      const owner = this.owner(exec.agent), policy = this.store.snapshot()
      const route = routeTool(exec.name, owner, policy.policy, [], '', (id) => this.providers.has(id))
      if (!route.allowed || route.profile?.providerId) throw new BrokerError('SCOPE_DENIED', route.reason + '；隔离实例通过 Sapper 工作流使用')
      session = { context: { owner, parent: exec.agent, selectors: [exec.name], text: '', requested: [], signal: exec.signal, guard: () => {}, progress: async () => {} }, policy, selection: { revision: policy.revision, selected: [exec.name], excluded: [], requiredCapabilities: [], missingCapabilities: [] }, profiles: new Map([[exec.name, route.profile]]), leases: [], instances: new Map(), ledger: new ObservationLedger(), calls: new Set(), receipts: [], saves: Promise.resolve(), refresh: false, closed: false, activated: false }
      temporary = true
      if (route.profile?.identity && this.ctx.tools.get(route.profile.identity.tool, exec.agent)) session.profiles.set(route.profile.identity.tool, route.profile)
      if (route.profile?.isolation !== 'stateless') {
        session.leases = await this.scheduler.acquire(owner.agentId + ':' + randomUUID(), [{ key: resourceKey(route.profile), backendId: route.profile?.backendId ?? 'unclassified:mcp', capacity: 1, exclusive: true }], exec.signal, policy.policy.waitMs)
      }
    }
    const current = session, profile = session.profiles.get(exec.name)
    let slots: ResourceLease[] = []
    try {
      if (!temporary) { this.check(session, exec.name, exec.agent, this.isCleanupCall(exec)); this.checkArguments(session, exec) }
      const slotKey = resourceKey(profile) + ':call:' + (profile?.providerId ? session.leases.find((l) => l.key === resourceKey(profile))?.slot : 'shared')
      slots = await this.slots.acquire(String(exec.agent.id), [{ key: slotKey, backendId: profile?.backendId ?? 'unclassified:mcp', capacity: profile?.maxInFlight ?? 1, exclusive: (profile?.effects[exec.name] ?? 'unknown') !== 'read' }], exec.signal, current.policy.policy.waitMs)
      const lease = current.leases.find((l) => l.key === resourceKey(profile)) ?? slots[0]!
      const schemaDigest = hash({ name: definition.name, description: definition.description, parameters: definition.parameters })
      if (exec.schema && hash({ name: exec.schema.name, description: exec.schema.description, parameters: exec.schema.parameters }) !== schemaDigest) throw new BrokerError('SCHEMA_CHANGED', '工具 schema 在排队期间已变化')
      this.calls.set(exec, { session: current, lease, profile, instance: current.instances.get(resourceKey(profile)), schemaDigest, invocationId: randomUUID(), startedAt: new Date().toISOString(), temporary, target: { assetRefs: [], assetDigests: [], binding: 'unattested' }, slots, released: false, bodyEntered: false, definition })
      await this.persist()
    } catch (error) {
      this.slots.release(slots)
      if (temporary) this.scheduler.release(current.leases)
      throw error
    }
  }
  private releaseCall(exec: Readonly<ToolExecution>) {
    const binding = this.calls.get(exec)
    if (!binding || binding.released) return
    binding.released = true
    this.slots.release(binding.slots)
    if (binding.temporary) this.scheduler.release(binding.session.leases)
    void this.persist().catch(() => {})
  }
  private async execute(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) {
    if (this.internalKinds.get(exec) === 'identity') { const binding = this.calls.get(exec); if (binding) binding.bodyEntered = true; return next() }
    const binding = this.calls.get(exec)
    if (!binding || binding.released) throw new BrokerError('LEASE_REVOKED', '工具调用没有经过资源门禁')
    const { session, lease, profile } = binding
    const operation = (async () => {
      if (!binding.temporary) this.check(session, exec.name, exec.agent, this.isCleanupCall(exec))
      else {
        const route = routeTool(exec.name, session.context.owner, this.store.snapshot().policy, [], '', (id) => this.providers.has(id))
        if (!route.allowed || JSON.stringify(route.profile) !== JSON.stringify(profile)) throw new BrokerError('LEASE_REVOKED', '排队期间资源范围或策略已经变化')
      }
      if (session.leases.includes(lease)) this.scheduler.active(lease)
      const rebinding = !binding.instance && profile?.identity && ['write', 'control'].includes(profile.effects[exec.name] ?? '') && Object.keys(profile.bindings[exec.name] ?? {}).length > 0
      if (!this.isCleanupCall(exec) && !rebinding) binding.target = await this.target(binding, exec)
      exec.signal.throwIfAborted()
      if (!binding.temporary) this.check(session, exec.name, exec.agent, this.isCleanupCall(exec))
      if (this.ctx.tools.get(exec.name, exec.agent) !== binding.definition) throw new BrokerError('SCHEMA_CHANGED', '执行前工具定义已被替换')
      this.checkArguments(session, exec)
      binding.bodyEntered = true
      try {
        const result = await next()
        if (!result.isError && !this.isCleanupCall(exec) && (binding.instance || profile?.identity)) {
          await this.target(binding, exec)
          if (!binding.instance && !profile?.targetTools.includes(exec.name)) binding.target = { assetRefs: [], assetDigests: [], binding: 'unattested' }
        }
        return result
      }
      catch (error) { if (session.leases.includes(lease)) this.scheduler.quarantine(lease, errorText(error)); throw error }
    })()
    session.calls.add(operation)
    try { return await operation } finally { session.calls.delete(operation) }
  }
  private record(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) {
    const binding = this.calls.get(exec)
    if (!binding) return
    const { session, lease, profile, instance } = binding, owner = session.context.owner
    if (binding.bodyEntered && result.isError && (exec.signal.aborted || /timeout|timed.out|超时|disconnect|ECONNRESET|EPIPE/i.test(result.error.message))) {
      if (session.leases.includes(lease)) this.scheduler.quarantine(lease, '调用取消/连接中断，远端是否停止尚未核实')
    }
    const identityRead = this.internalKinds.get(exec) === 'identity' && (exec.name === profile?.identity?.tool || exec.name === profile?.native?.verify.tool)
    if (binding.bodyEntered && !identityRead && (profile?.effects[exec.name] ?? 'unknown') !== 'read') lease.epoch++
    const receipt: BrokerReceipt = {
      protocol: 'sapper-mcp/1', kind: 'receipt', receiptId: randomUUID(), invocationId: binding.invocationId, callId: String(exec.callId),
      owner: { hostInstanceId: owner.hostInstanceId, workspaceId: owner.workspaceId, agentId: owner.agentId, role: owner.role, ...(owner.role === 'main' ? { sessionId: owner.agentId } : { challengeId: owner.taskId, taskId: owner.taskId, runId: owner.runId }) },
      toolRef: { connectionRef: profile?.id ?? 'unclassified:mcp', publicName: exec.name, schemaDigest: binding.schemaDigest },
      argumentsDigest: hash(exec.arguments), resultDigest: hash(result.content), resource: { backendId: lease.backendId, resourceId: instance?.resourceId ?? 'lease:' + hash([lease.key, lease.slot]).slice(7), kind: profile?.isolation === 'stateless' ? 'stateless' : 'generic', generation: instance?.generation ?? lease.fence },
      target: binding.target, fence: lease.fence, epoch: lease.epoch,
      status: result.isError ? exec.signal.aborted ? 'cancelled' : 'error' : 'success', source: binding.target.binding === 'attested' ? 'target' : 'unbound', artifacts: [],
      startedAt: binding.startedAt, endedAt: new Date().toISOString(), ...(result.isError ? { errorCode: exec.signal.aborted ? 'CANCELLED' as const : 'TOOL_ERROR' as const } : {}),
    }
    try { receiptWireSchema.parse(receipt) } catch (error) { this.persistenceError = '资源回执校验失败：' + errorText(error); return }
    session.receipts.push(receipt); this.diagnostics.push(receipt); this.diagnostics = this.diagnostics.slice(-128)
    for (const record of session.ledger.record(receipt, result, profile)) if (session.context.archiveRecord) session.saves = session.saves.then(() => session.context.archiveRecord!(record))
    if (session.context.archive) session.saves = session.saves.then(() => session.context.archive!(receipt, result))
    void session.saves.catch(() => {})
  }
  private async drain(session: SessionBinding) { await Promise.allSettled([...session.calls]); await session.saves }
  private async release(session: SessionBinding) {
    for (const [key, instance] of session.instances) {
      const lease = session.leases.find((l) => l.key === key)!
      try { await instance.close(new AbortController().signal, async (name, args) => { const agent = this.ctx.agents.get(session.context.owner.agentId as import('@deepseek-ai/dsh-session').SessionId); if (!agent) throw new BrokerError('ADAPTER_UNAVAILABLE', '资源 Agent 已退出，不能伪造身份清理'); return this.invoke(agent, name, args, AbortSignal.timeout(10000), 'cleanup') }); if (lease.state === 'quarantined') lease.state = 'released' }
      catch (error) { this.scheduler.quarantine(lease, '隔离实例关闭失败：' + errorText(error)) }
    }
    session.instances.clear(); this.scheduler.release(session.leases); const finished = structuredClone(session.leases); session.leases = []; await this.persist(); return finished
  }
  async finish(agentId: string) {
    const session = this.sessions.get(agentId)
    if (!session) return
    this.scheduler.cancelOwner(agentId, new BrokerError('LEASE_REVOKED', '资源申请已取消'))
    await this.closeInteractions(agentId)
    session.closed = true
    const info = this.info(agentId)
    try { await this.drain(session) }
    finally { const leases = await this.release(session); this.sessions.delete(agentId); if (info) { info.leases = leases; info.receipts = structuredClone(session.receipts) } await session.saves }
    return info
  }
  async interact(agent: Agent, input: unknown, signal: AbortSignal) {
    const args = interactionRequestSchema.parse(input), session = this.sessions.get(String(agent.id))
    if (!session || session.context.owner.role === 'reason') throw new BrokerError('SCOPE_DENIED', '交互能力需要探索/复核工作流')
    const profile = [...session.profiles.values()].find((p) => p?.id === args.profileId)
    if (args.action === 'start' && (!profile?.interaction || !Object.values(profile.interaction).filter((v): v is { tool: string; arguments: Record<string, never> } => !!v && typeof v === 'object' && 'tool' in v).every((op) => session.profiles.has(op.tool) && this.ctx.tools.get(op.tool, agent))))
      throw new BrokerError('ADAPTER_UNAVAILABLE', '交互工具映射未配置或不在本工作流可见范围')
    return this.interactions.run(agent, args, profile?.interaction, signal)
  }
  async closeInteractions(agentId: string) {
    const session = this.sessions.get(agentId)
    if (!session) return
    const failures = await this.interactions.close(agentId, AbortSignal.timeout(10000), (agent, name, args, signal) => this.invoke(agent, name, args, signal, 'cleanup'))
    for (const failure of failures) {
      const profile = [...session.profiles.values()].find((p) => p?.id === failure.profileId)
      const lease = session.leases.find((l) => l.key === resourceKey(profile))
      if (lease) this.scheduler.quarantine(lease, '交互会话未确认关闭：' + failure.error)
    }
  }
  observe(agentId: string, input: { action: string; receiptId?: string | undefined; claim?: string | undefined; value?: string | undefined; preserve?: string[] | undefined; invalidate?: string[] | undefined; resumeFrom?: string | undefined; nextCapability?: string | undefined; reason?: string | undefined; ids?: string[] | undefined }) {
    const session = this.sessions.get(agentId)
    if (!session) throw new BrokerError('SCOPE_DENIED', '需要当前工作流')
    const receipts = session.receipts, current = this.currentResources(session)
    const assets = this.currentAssets(session)
    if (input.action === 'list') return session.ledger.list(current, assets).filter((o) => session.context.owner.role !== 'verify' || o.owner.agentId === agentId)
    if (input.action === 'require') { if (session.context.owner.role === 'verify' && (input.ids ?? []).some((id) => !session.ledger.list(current, assets).some((o) => o.observationId === id && o.owner.agentId === agentId))) throw new BrokerError('SCOPE_DENIED', '独立复核不能借用其他 Agent 的测量作为新证据'); session.ledger.require(input.ids ?? [], current, assets); return { satisfied: true } }
    if (session.context.owner.role === 'reason') throw new BrokerError('SCOPE_DENIED', '规划角色只能查询观测')
    const receipt = receipts.find((r) => r.receiptId === input.receiptId)
    if (!receipt) throw new BrokerError('SCOPE_DENIED', '必须引用本工作流实际工具回执')
    if ((input.invalidate ?? []).some((id) => !session.ledger.list(current, assets).some((o) => o.observationId === id && o.owner.agentId === agentId))) throw new BrokerError('SCOPE_DENIED', '不能失效其他 Agent 拥有的测量')
    const record = input.action === 'infer' ? session.ledger.infer(receipt, input.claim?.trim() || '代理推断', input.value === undefined ? null : JSON.parse(input.value)) : session.ledger.diagnose(receipt, { preserve: input.preserve ?? [], invalidate: input.invalidate ?? [], resumeFrom: ['current-state', 'last-safe-checkpoint', 'fresh-resource'].includes(input.resumeFrom ?? '') ? input.resumeFrom as 'current-state' | 'last-safe-checkpoint' | 'fresh-resource' : 'fresh-resource', nextCapability: input.nextCapability ?? 'binary.inspect', reason: input.reason?.trim() || '根据实际失败重新选择资源与测量' })
    if (session.context.archiveRecord) session.saves = session.saves.then(() => session.context.archiveRecord!(record))
    return record
  }
  private currentResources(session: SessionBinding) {
    return session.leases.filter((l) => l.state === 'active').map((l) => ({ backendId: l.backendId, resourceId: session.instances.get(l.key)?.resourceId ?? 'lease:' + hash([l.key, l.slot]).slice(7), generation: session.instances.get(l.key)?.generation ?? l.fence, epoch: l.epoch }))
  }
  private currentAssets(session: SessionBinding) {
    const current = this.currentResources(session)
    return session.receipts.filter((r) => r.status === 'success' && current.some((c) => c.resourceId === r.resource.resourceId && c.generation === r.resource.generation)).flatMap((r) => r.target.assetDigests)
  }
  info(agentId: string) {
    const s = this.sessions.get(agentId)
    return s ? { selection: structuredClone(s.selection), leases: structuredClone(s.leases), observations: s.ledger.list(this.currentResources(s), this.currentAssets(s)).filter((o) => s.context.owner.role !== 'verify' || o.owner.agentId === agentId), repairPlans: structuredClone(s.ledger.plans.filter((p) => s.context.owner.role !== 'verify' || p.owner.agentId === agentId)), resourceHints: [...s.instances.values()].map((i) => ({ resourceId: i.resourceId, bindings: i.bindings ?? {} })).concat([...new Set(s.profiles.values())].filter((p): p is ToolProfile => !!p && Object.keys(p.bindings).length > 0).map((p) => ({ resourceId: p.backendId, bindings: {}, toolBindings: Object.fromEntries(Object.entries(p.bindings).map(([name, bindings]) => [name, Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, value.replaceAll('{{cwd}}', s.context.owner.cwd).replaceAll('{{taskId}}', s.context.owner.taskId)]))])) }))), receipts: structuredClone(s.receipts) } : undefined
  }
  preview(parent: Agent, role: 'explore' | 'verify', name: string) {
    return routeTool(name, { ...this.owner(parent), role }, this.store.snapshot().policy, [], '', (id) => this.providers.has(id))
  }
  catalog(agent: Agent, query: string, planning?: { selectors: readonly string[]; purpose?: string }) {
    const session = this.sessions.get(String(agent.id)), owner = session?.context.owner ?? this.owner(agent)
    const parent = session?.context.parent ?? agent, policy = this.store.snapshot().policy
    const selectors = planning?.selectors ?? session?.context.selectors ?? EXPLORE_TOOLS
    const executionRole = planning || owner.role === 'reason' ? 'explore' : owner.role
    const scope = { ...owner, role: executionRole, ...(planning?.purpose ? { purpose: planning.purpose } : {}) }
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return this.ctx.tools.schemas(parent).filter((t) => this.ctx.tools.get(t.name, parent) && matchesTool(selectors, t.name))
      .flatMap((t) => {
        const route: ReturnType<typeof routeTool> = mcpTool(t.name) ? routeTool(t.name, scope, { ...policy, selection: 'all' }, [], '', (id) => this.providers.has(id)) : { allowed: true, reason: '本地执行工具；服从原生权限检查' }
        if (!route.allowed) return []
        return [{ name: t.name, description: t.description, kind: mcpTool(t.name) ? 'mcp' : 'native', executionRole, capabilities: route.profile?.capabilities ?? [], profileId: route.profile?.id ?? null, isolation: mcpTool(t.name) ? route.profile?.isolation ?? 'generic-exclusive' : null, schema: t }]
      }).map((t) => {
        const haystack = [t.name, t.description, ...t.capabilities, JSON.stringify(t.schema.parameters)].join(' ').toLowerCase()
        return { tool: t, score: (t.name.toLowerCase() === query.trim().toLowerCase() ? 1000 : 0) + terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) }
      }).filter((t) => !terms.length || t.score > 0)
      .sort((a, b) => b.score - a.score || Number(a.tool.kind === 'mcp') - Number(b.tool.kind === 'mcp') || a.tool.name.localeCompare(b.tool.name))
      .slice(0, 50).map((t) => t.tool)
  }
  toolStatus(agent: Agent) {
    const session = this.sessions.get(String(agent.id)), role = session?.context.owner.role ?? 'main'
    return { ...(this.selection(String(agent.id)) ?? {}), role, catalogRole: role === 'reason' ? 'explore' : role,
      message: role === 'reason' ? '规划角色只读；以下目录是探索角色可申请的执行工具，不代表规划角色可以执行。未列出专用 MCP 不代表本地文件/命令工具不可用。' : '目录仅描述当前作用域；执行仍需宿主、连接器与资源授权。',
      availableTools: this.catalog(agent, '').map(({ schema: _schema, ...tool }) => tool) }
  }
}
