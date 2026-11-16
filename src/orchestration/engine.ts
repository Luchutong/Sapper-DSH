import { setTimeout as waitCapacity } from 'node:timers/promises'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import { validateConfig } from '../settings.js'
import { GraphStore } from '../store/graph.js'
import type { WriteOptions } from '../store/graph.js'
import type { RunRecord, RunOutcome, ChildCapabilities, Candidate } from '../store/runs.js'
import { StoreError } from '../store/validation.js'
import { frontier } from '../render/frontier.js'
import { renderGraphContext } from '../render/snapshot.js'
import { UNTRUSTED_NOTICE } from '../render/context.js'
import { isMutation } from '../tools/graph.js'
import { normalize } from '../recall/index.js'
import {
  SCHEMAS,
  parseProposals,
  parseCandidate,
  parseVerification,
} from './types.js'
import type { DispatchMode, CapturedCall } from './types.js'
import { ChildBudget } from './budget.js'
import { flagLiterals } from './flags.js'
import { matchesTool } from './tool-policy.js'
import { collectedFlags, defaultFlagPolicy, flagProgress, projectFlagPolicy } from './flag-policy.js'
import { checkCandidateEvidence, verificationModeSchema } from './verification-policy.js'

interface Child {
  role: 'reason' | 'explore' | 'verify'; controller: AbortController; calls: Map<string, CapturedCall>
  budget: ChildBudget; progress: Set<string>; capabilities?: ChildCapabilities; config: Config; guard: () => void
  onReady: (capabilities: ChildCapabilities) => Promise<void>
  onFlags?: ((candidates: Candidate[]) => Promise<void>) | undefined
  notifications: Promise<void>
  parent: Agent
  closing?: boolean
  mask?: { key: string; dispose(): void }
}
class StopRunError extends StoreError {}
class FlagStop extends StoreError {}
function mustStop(error: unknown): boolean {
  return error instanceof StopRunError || (error instanceof Error && error.cause !== undefined && mustStop(error.cause)) ||
    (error instanceof AggregateError && error.errors.some(mustStop))
}
const require = createRequire(import.meta.url)
const readTools = new Set(['sapper_status', 'sapper_fact', 'sapper_intent', 'sapper_doc', 'sapper_flag', 'sapper_recall', 'sapper_kb'])

/** Owns exact managed activations. Child identities are reserved before first publication. */
export class Orchestrator {
  private children = new Map<string, Child>()
  private updatingTools = false
  private active = new Map<string, AbortController>()
  constructor(
    private ctx: Context,
    private getConfig: () => Config,
    private alive: () => boolean,
    private progress?: (
      parent: Agent,
      root: string,
      run: RunRecord,
      stage: string,
    ) => Promise<void>,
  ) {
    ctx.on('tools/change', () => {
      if (this.updatingTools) return
      for (const [id, child] of this.children) {
        const agent = ctx.agents.get(id as SessionId)
        if (agent && !child.closing && !child.budget.finalizing) try { this.refreshTools(child, agent) } catch (error) { child.controller.abort(error) }
      }
    })
    ctx.on('agent/created', async ({ agent }) => {
      const child = this.children.get(String(agent.id))
      if (!child) return
      // Preset tools live on ancestor scopes, not necessarily the global registry.
      // A child-local native declaration also keeps structured_output callable under a PTC preset.
      agent.ctx.tools.presentAs('native')
      this.refreshTools(child, agent)
      agent.ctx.tools.guard(exec => this.denial(exec))
      const tools = ctx.tools.schemas(agent).map(t => t.name)
      const external = tools.filter(name => this.external(child, name))
      child.capabilities = { role: child.role, session_id: String(agent.id), tools, external_tools: external, tool_selectors: child.role === 'reason' ? [] : child.role === 'explore' ? child.config.orchestration.exploreTools : child.config.orchestration.verifyTools, ...(agent.options.provider ? { provider: agent.options.provider } : {}), ...(agent.options.model ? { model: agent.options.model } : {}), ...(agent.options.reasoningEffort ? { reasoning_effort: String(agent.options.reasoningEffort) } : {}), max_output_tokens: child.config.orchestration.maxOutputTokens, state: 'running', steps: 0, step_limit: child.budget.limit, step_ceiling: child.config.orchestration.budgetMode === 'adaptive' && child.role !== 'reason' ? Math.max(child.budget.limit, child.config.orchestration.maxChildStepsCeiling) : child.budget.limit, started_at: new Date().toISOString() }
      await child.onReady(child.capabilities)
      if (child.role !== 'reason' && !external.length) throw new StopRunError(`SAPPER_M3_TOOL_UNAVAILABLE: ${child.role} 未获得白名单中的外部取证工具；可见工具: ${tools.join(', ')}。请检查 DSH preset 与 orchestration.${child.role === 'explore' ? 'exploreTools' : 'verifyTools'}，增加 token 预算无法补齐工具。`)
      return undefined
    })
    ctx.tools.guard((exec) => this.denial(exec))
    ctx.on('tools/result', (exec, result) => {
      const child = this.children.get(String(exec.agent?.id))
      if (!child || result.isError) return
      if (exec.name === 'structured_output' && child.onFlags) {
        const candidate = parseCandidate(exec.arguments, String(exec.agent!.id), child.calls)
        if (candidate.kind === 'flag') this.notifyFlags(child, [candidate])
        return
      }
      if (!this.external(child, exec.name)) return
      const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      if (text.trim()) {
        child.progress.add(createHash('sha256').update(exec.name + JSON.stringify(exec.arguments) + text).digest('hex'))
        const receipt_id = 'ev-' + randomUUID()
        child.calls.set(String(exec.callId), { tool: exec.name, text, receipt_id })
        const notice = `Sapper evidence receipt: ${JSON.stringify({ receipt_id, tool: exec.name })}. This receipt certifies this session's successful tool output. To cite it, use evidence: [{"receipt_id":"${receipt_id}"}]. Do not copy or escape the output.`
        exec.agent?.inject(createUserMessage({ content: [{ type: 'text', text: notice }], source: { kind: 'sapper-dsh', form: 'evidence', sections: [{ name: 'Evidence receipt', text: notice }] } }))
        if (child.onFlags) {
          const candidates = flagLiterals(text).map((value) => parseCandidate({
            title: '工具输出中的 flag 候选', description: value, kind: 'flag', evidence: [{ receipt_id }],
            reproduction: `Independently reproduce the successful ${exec.name} observation. Original arguments: ${JSON.stringify(exec.arguments).slice(0, 10000)}`,
          }, String(exec.agent!.id), child.calls))
          if (candidates.length) this.notifyFlags(child, candidates)
        }
      }
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      const child = this.children.get(String(payload.agent.id))
      if (!child) return next()
      try {
        child.guard()
        if (!child.budget.finalizing) this.refreshTools(child, payload.agent)
        const budget = child.budget.next(child.progress.size)
        if (budget.exhausted) throw new StopRunError('子代理步数预算耗尽（结构化收尾仍未完成）')
        if (child.capabilities) {
          Object.assign(child.capabilities, { steps: child.budget.steps, step_limit: child.budget.limit, extensions: child.budget.extensions, finalizing: budget.finalizing })
          await child.onReady(child.capabilities)
        }
        if (budget.finalizing) payload.agent.ctx.tools.restrict({ allow: [] })
        const decision = await next()
        if (decision.kind === 'reject') return decision
        if (budget.finalizing) {
          const text = `Sapper finalization: ${child.budget.limit - child.budget.steps + 1} steps remain. Only structured_output is available. Submit your current conclusion NOW using this session's evidence receipts. If verification is incomplete, submit verified=false and explain the missing evidence. Do not claim unobserved success.`
          return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'sapper-dsh', form: 'budget', sections: [{ name: 'Sapper finalization', text }] } })] }
        }
        return decision
      } catch (error) { child.controller.abort(error); return { kind: 'reject' } }
    })
    ctx.on('loader/volatile-update', () => {
      for (const child of this.children.values()) if (!this.alive() || JSON.stringify(this.getConfig()) !== JSON.stringify(child.config)) {
        for (const controller of this.active.values()) controller.abort(new StoreError('Sapper 配置已变化'))
        child.controller.abort(new StoreError('Sapper 配置已变化'))
      }
    })
    ctx.effect(() => () => { for (const controller of this.active.values()) controller.abort(new StoreError('Sapper 已卸载')); for (const child of this.children.values()) child.controller.abort(new StoreError('Sapper 已卸载')) })
  }
  isChild(agent: Agent): boolean {
    return this.children.has(String(agent.id))
  }
  private notifyFlags(child: Child, candidates: Candidate[]) {
    // tools/result is a synchronous observation seam. Own the asynchronous
    // persistence/publication here and drain it before any verification starts.
    child.notifications = child.notifications.then(() => child.onFlags!(candidates))
    void child.notifications.catch((error) => child.controller.abort(error))
  }
  isActive(root: string): boolean {
    return this.active.has(root)
  }
  cancel(root: string): void {
    this.active.get(root)?.abort(new StoreError('用户取消任务'))
  }
  private external(child: Child, name: string): boolean {
    return child.role !== 'reason' && !name.startsWith('sapper_') && name !== 'structured_output' &&
      !!this.ctx.tools.get(name, child.parent) &&
      matchesTool(child.role === 'explore' ? child.config.orchestration.exploreTools : child.config.orchestration.verifyTools, name)
  }
  private refreshTools(child: Child, agent: Agent): void {
    if (this.updatingTools) return
    this.updatingTools = true
    try {
      // Registry schemas are presentation-agnostic. Read the ancestor view so our
      // own finite mask cannot hide tools registered since the last boundary.
      const inherited = scopeParentOf(agent)
      const names = this.ctx.tools.schemas(inherited).map((t) => t.name).filter((name) => name !== 'run_code' && this.ctx.tools.get(name, child.parent) &&
        ((child.role !== 'verify' && readTools.has(name)) || this.external(child, name))).sort()
      const key = names.join('\n')
      if (child.mask?.key === key) return
      const dispose = agent.ctx.tools.restrict({ allow: names }), previous = child.mask
      child.mask = { key, dispose }
      previous?.dispose()
      if (child.capabilities) {
        child.capabilities.tools = this.ctx.tools.schemas(agent).map((t) => t.name)
        child.capabilities.external_tools = child.capabilities.tools.filter((name) => this.external(child, name))
      }
    } finally { this.updatingTools = false }
  }
  private allowed(child: Child, name: string, args: unknown): boolean {
    if (name === 'structured_output') return true
    if (child.budget.finalizing) return false
    if (!this.ctx.tools.get(name, child.parent)) return false
    if (child.role === 'verify') return this.external(child, name)
    return (readTools.has(name) && !isMutation(name, args)) || this.external(child, name)
  }
  denial(exec: Readonly<ToolExecution>): string | undefined {
    const child = this.children.get(String(exec.agent?.id))
    if (!child) return
    try { child.controller.signal.throwIfAborted(); child.guard(); if (!this.allowed(child, exec.name, exec.arguments)) return `Sapper ${child.role} 角色不允许 ${exec.name}；图写入及递归委派由编排器管理` }
    catch (error) { child.controller.abort(error); return (error as Error).message }
    return undefined
  }
  private preflight() {
    const service = this.ctx.get('subagents'), provider = service?.getProvider('spawn')
    if (!service || !provider) throw new StoreError('需要 DSH subagents 服务及 spawn 提供者；请启用内置子代理能力')
    if (provider.inheritsParentContext || !provider.prepareContinuable || !provider.capabilities.outputSchema || !provider.capabilities.agentOptions || !provider.capabilities.depthLimit) throw new StoreError('M3 需要独立上下文、结构化输出、模型选择与深度限制的本地 spawn 提供者')
    return service
  }
  private async child(
    role: Child['role'],
    data: unknown,
    parent: Agent,
    config: Config,
    signal: AbortSignal,
    guard: () => void,
    onReady: Child['onReady'],
    onFlags?: Child['onFlags'],
  ) {
    guard()
    signal.throwIfAborted()
    const service = this.preflight(),
      session = randomUUID() as SessionId
    const controller = new AbortController(),
      onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const child: Child = { role, controller, config, guard, calls: new Map(), budget: new ChildBudget(config.orchestration, config.orchestration.budgetMode === 'adaptive' && role !== 'reason'), progress: new Set(), onReady, onFlags, notifications: Promise.resolve(), parent }
    this.children.set(session, child)
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = setInterval(() => {
      try {
        guard()
      } catch (error) {
        controller.abort(error)
      }
    }, 500)
    let activation:
      | Awaited<ReturnType<typeof service.startActivation>>
      | undefined
    const stop = () => {
      void activation?.dispose().catch(() => {})
    }
    try {
      const root = path.dirname(require.resolve('sapper-dsh/package.json'))
      const prompt = await readFile(
        path.join(root, 'resources', 'prompts', role + '.md'),
        'utf8',
      )
      const selected = config.orchestration.models[role], agentOptions: AgentOptions = { maxTokens: config.orchestration.maxOutputTokens }
      if (selected !== 'inherit') {
        const colon = selected.indexOf(':')
        if (colon >= 0) { agentOptions.provider = selected.slice(0, colon); agentOptions.model = selected.slice(colon + 1) }
        else agentOptions.model = selected
      }
      const roleEffort = config.orchestration.reasoningEfforts[role]
      const effort = roleEffort !== 'inherit' ? roleEffort : config.orchestration.reasoningEffort
      if (effort !== 'inherit') {
        agentOptions.reasoningEffort = ReasoningEffortId(effort)
        const inherited = parent.session.requestHeader()?.config ?? parent.options
        const provider = agentOptions.provider ?? inherited.provider, model = agentOptions.model ?? inherited.model
        const info = provider && model ? await this.ctx.get('llm')?.resolveModelInfo(provider, model, controller.signal) : undefined
        if (!info?.reasoning?.efforts.some((e) => String(e.id) === effort))
          throw new StopRunError(`SAPPER_REASONING_UNSUPPORTED: ${role} 的 ${provider ?? '?'}:${model ?? '?'} 不支持推理档位 ${effort}；可选：${info?.reasoning?.efforts.map((e) => String(e.id)).join(', ') || '模型默认'}。请在 Sapper 设置调整，不会静默替换。`)
      }
      guard()
      controller.signal.throwIfAborted()
      for (;;) {
        try {
          activation = await service.startActivation({ provider: 'spawn', childId: session, label: `Sapper ${role}`, delivery: 'caller', signal: controller.signal,
        request: { parent, cwd: parent.session.header.cwd!, prompt: [{ type: 'text', text: prompt + '\n\n' + UNTRUSTED_NOTICE + '\n' + JSON.stringify(data) }],
          outputSchema: SCHEMAS[role], agentOptions, maxDepth: service.resolveMaxDepth() ?? 1 } })
          break
        } catch (error) {
          if ((error as { code?: string }).code !== 'ACTIVATION_LIMIT_REACHED')
            throw error
          await waitCapacity(200, undefined, { signal: controller.signal })
          guard()
        }
      }
      timer = setTimeout(
        () => controller.abort(new StopRunError('子代理超时')),
        config.orchestration.timeoutMin * 60000,
      )
      controller.signal.addEventListener('abort', stop, { once: true })
      if (controller.signal.aborted) stop()
      const result = await activation.result
      await child.notifications
      controller.signal.throwIfAborted()
      guard()
      if (result.stopReason !== 'completed' || result.structured === undefined) throw new StopRunError(`子代理 ${role} 未完成结构化结果：${result.stopReason}（maxOutputTokens=${config.orchestration.maxOutputTokens}）；本次运行停止，不重复 reason 消耗预算`)
      if (child.capabilities) child.capabilities.state = 'completed'
      return { value: result.structured, session, calls: child.calls }
    } finally {
      await child.notifications.catch(() => {})
      child.closing = true
      if (child.capabilities) { child.capabilities.state ??= 'failed'; if (child.capabilities.state === 'running') child.capabilities.state = child.controller.signal.reason instanceof FlagStop ? 'stopped' : 'failed'; child.capabilities.ended_at = new Date().toISOString(); try { await child.onReady(child.capabilities) } catch {} }
      try { await activation?.dispose() } finally { controller.signal.removeEventListener('abort', stop); clearTimeout(timer); clearInterval(poll); signal.removeEventListener('abort', onAbort); this.children.delete(session) }
    }
  }
  async dispatch(
    mode: DispatchMode,
    store: GraphStore,
    actor: string,
    parent: Agent,
    options: WriteOptions,
    intentId?: string,
    sourceRunId?: string,
  ): Promise<RunRecord> {
    validateConfig(this.getConfig())
    if (this.isChild(parent)) throw new StoreError('M3 子代理不能递归编排')
    this.preflight()
    options.guard?.()
    options.signal?.throwIfAborted()
    if (this.active.has(store.root))
      throw new StoreError('当前工作区已有 M3 运行，请先等待其结束或取消')
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
    this.active.set(store.root, controller)
    const config = structuredClone(this.getConfig()),
      runOptions = { ...options, signal }
    const deadline = setTimeout(() => controller.abort(new StopRunError('运行时长上限已到，已保留可恢复的结果')), config.orchestration.runTimeoutMin * 60000)
    let record: RunRecord | undefined
    let updateFlagProgress: (() => void) | undefined
    const guard = () => { options.guard?.(); signal.throwIfAborted(); if (!this.alive() || !this.getConfig().enabled || JSON.stringify(config) !== JSON.stringify(this.getConfig())) throw new StoreError('Sapper 已关闭或配置已改变') }
    try {
      guard()
      let initial = await store.read()
      if (!initial.project.flag_policy && initial.project.stop_on_flag !== false && initial.project.purpose !== 'writeup') {
        await store.configureFlagPolicy(defaultFlagPolicy(config.flags), runOptions)
        initial = await store.read()
      }
      record = await store.beginRun(mode, actor, runOptions)
      const run = record,
        managed = { ...runOptions, managedRun: run.id }
      const policy = projectFlagPolicy(initial.project) ?? { mode: 'all' as const, count: 2 }
      const writeup = initial.project.purpose === 'writeup'
      const collectionMode = !writeup && !!initial.project.flag_policy && policy.mode !== 'first'
      const stopOnFlag = !writeup && policy.mode === 'first'
      const verificationMode = verificationModeSchema.parse(initial.project.verification_mode ?? config.verification.mode)
      run.verification_mode = mode === 'verify' ? 'independent' : verificationMode
      const history = (await store.listRuns()).filter((r) => r.id !== run.id)
      const known = collectedFlags(initial.facts, history)
      updateFlagProgress = () => { if (!writeup) run.flag_progress = flagProgress(policy, initial.facts, [...history, run]) }
      updateFlagProgress()
      const flagContext = () => ({ policy, found: run.flag_progress?.found ?? 0, found_values: [...known].filter(([, status]) => status !== 'rejected').map(([v]) => v).slice(-128) })
      let foundFlag = false
      const pipelines = new Set<AbortController>()
      const stopForFlag = async () => {
        updateFlagProgress?.()
        if (foundFlag || writeup || policy.mode === 'all' || (run.flag_progress?.found ?? 0) < (policy.mode === 'count' ? policy.count : 1)) return
        foundFlag = true; run.stop_reason = policy.mode === 'count' ? 'flag-target-reached' : 'flag-found'
        for (const pipeline of pipelines) pipeline.abort(new FlagStop('已达到 flag 收集目标，停止其他路线'))
        await this.progress?.(parent, store.root, run, run.stop_reason)
      }
      const onReady = async (capabilities: ChildCapabilities) => {
        updateFlagProgress?.()
        run.children ??= []
        const index = run.children.findIndex(c => c.session_id === capabilities.session_id)
        if (index < 0) run.children.push({ ...capabilities })
        else run.children[index] = { ...capabilities }
        await store.saveRun(run, runOptions)
        if (index < 0) await this.progress?.(parent, store.root, run, capabilities.role)
      }
      const reason = async () => {
        const graph = await store.read()
        const output = await this.child('reason', { flag_collection: flagContext(), verification_policy: verificationMode, graph: renderGraphContext(graph, { ...config, context: { ...config.context, scope: 'frontier-history' } }, { fullAccess: options.autoConfirm?.() ?? false, actor }).text }, parent, config, signal, guard, onReady)
        const proposals = parseProposals(output.value)
        // Validate the entire batch before creating the first intent.
        const keys = new Set(graph.intents.map(i => normalize(i.description) + ':' + [...i.from].sort().join(',')))
        for (const p of proposals) {
          const key = normalize(p.description) + ':' + [...new Set(p.from)].sort().join(',')
          if (keys.has(key) || p.from.some(id => id === 'goal' || !graph.facts.some(f => f.id === id))) throw new StoreError('reason 返回重复意图或未知事实依赖')
          keys.add(key)
        }
        for (const proposal of proposals) run.intent_ids.push((await store.addIntent({ ...proposal, requires_confirmation: config.orchestration.requireApproval }, actor, managed)).id)
        await store.saveRun(run, runOptions)
        return proposals.length
      }
      const verify = async (outcome: RunOutcome, pipelineSignal: AbortSignal) => {
        if (!outcome.candidate || outcome.verify_attempts >= config.orchestration.maxVerify) throw new StoreError('候选不存在或复核次数已达上限')
        outcome.verify_attempts = await store.reserveVerification(outcome.intent_id, actor, run.id, outcome.candidate.explorer_session, config.orchestration.maxVerify, { ...managed, signal: pipelineSignal })
        await store.saveRun(run, runOptions)
        const intent = await store.readNode('intent', outcome.intent_id)
        // No explorer transcript, reasoning, graph history, or unrelated facts are sent.
        const output = await this.child('verify', { goal: (await store.read()).project.goal, intent: { id: intent.id, description: intent.description, success_criteria: intent.doc, completes_goal: intent.completes_goal === true }, candidate: outcome.candidate }, parent, config, pipelineSignal, guard, onReady)
        outcome.verification = parseVerification(output.value, output.session, output.calls)
        if (!outcome.verification.verified) throw new StoreError('verify rejected: ' + outcome.verification.issues)
        await store.promoteVerified(run, outcome, actor, { ...managed, signal: pipelineSignal })
        if (outcome.candidate.kind === 'flag') await stopForFlag()
      }
      const attempt = async (nodeId: string, existing?: RunOutcome) => {
        guard()
        if (foundFlag) return
        const pipeline = new AbortController()
        pipelines.add(pipeline)
        const pipelineSignal = AbortSignal.any([signal, pipeline.signal])
        await store.intentAction('claim', nodeId, actor, undefined, managed)
        const outcome: RunOutcome = existing ? structuredClone(existing) : { intent_id: nodeId, state: 'pending-verification', verify_attempts: 0 }
        outcome.state = 'pending-verification'
        delete outcome.fact_id
        delete outcome.error
        run.outcomes.push(outcome)
        run.steps++
        await store.saveRun(run, runOptions)
        try {
          if (!existing) {
            run.explored++
            const graph = await store.read(), intent = graph.intents.find(i => i.id === nodeId)!
            const publishFlags = graph.project.purpose === 'writeup' ? undefined : async (candidates: Candidate[]) => {
              guard()
              if (foundFlag) return
              run.flag_observations ??= []
              const fresh = candidates.filter((candidate) => !known.has(candidate.description.trim()))
              if (!fresh.length) return
              for (const candidate of fresh) known.set(candidate.description.trim(), 'unverified')
              run.flag_observations.push(...fresh.map((candidate) => ({ intent_id: nodeId, candidate })))
              updateFlagProgress?.()
              // Keep an independently verifiable candidate even when stopping the
              // explorer before it returns structured_output or finishes disposal.
              if (stopOnFlag || policy.mode === 'count') outcome.candidate = fresh[0]!
              await store.saveRun(run, runOptions)
              await stopForFlag()
              if (!foundFlag) await this.progress?.(parent, store.root, run, 'flag-candidate')
            }
            const output = await this.child('explore', { goal: graph.project.goal, flag_collection: flagContext(), verification_policy: verificationMode, intent, facts: graph.facts.filter(f => intent.from.includes(f.id)) }, parent, config, pipelineSignal, guard, onReady, publishFlags)
            outcome.candidate = parseCandidate(output.value, output.session, output.calls)
            const independent = verificationMode === 'independent' || (verificationMode === 'selective' && config.verification.criticalKinds.includes(outcome.candidate.kind))
            if (mode !== 'explore' && !independent) outcome.evidence_check = checkCandidateEvidence(outcome.candidate, output.calls, verificationMode === 'none' ? 'none' : 'lightweight')
            updateFlagProgress?.()
            await store.saveRun(run, runOptions)
          }
          if (!existing && stopOnFlag && outcome.candidate?.kind === 'flag') {
            await stopForFlag()
            await store.intentAction('release', nodeId, actor, undefined, managed)
            return
          }
          pipelineSignal.throwIfAborted()
          const independent = mode === 'verify' || verificationMode === 'independent' || (verificationMode === 'selective' && outcome.candidate && config.verification.criticalKinds.includes(outcome.candidate.kind))
          if (mode === 'explore') await store.intentAction('release', nodeId, actor, undefined, managed)
          else if (independent) await verify(outcome, pipelineSignal)
          else {
            await store.recordEvidence(run, outcome, actor, { ...managed, signal: pipelineSignal })
            await this.progress?.(parent, store.root, run, 'evidence-recorded')
            const intent = await store.readNode('intent', nodeId)
            if (!collectionMode && intent.completes_goal === true && outcome.candidate?.goal_achieved === true) {
              foundFlag = true; run.stop_reason = 'evidence-goal-reached'
              for (const other of pipelines) if (other !== pipeline) other.abort(new FlagStop('已有工具证据，快速策略结束本轮'))
            }
          }
        } catch (error) {
          if (pipeline.signal.reason instanceof FlagStop) {
            if (!outcome.fact_id) {
              outcome.state = outcome.candidate ? 'pending-verification' : 'stopped'
              const { signal: _cancelled, ...cleanup } = managed
              await store.intentAction('release', nodeId, actor, undefined, cleanup)
            }
            return
          }
          outcome.state = 'failed'
          outcome.error = (error as Error).message
          // Cleanup may record a cancellation, but still rechecks current file permissions/config.
          const { signal: _cancelled, ...cleanup } = options
          try {
            await store.failManaged(nodeId, actor, run, outcome.error, cleanup)
          } catch {
            /* Revoked writes leave a visible claimed intent for explicit recovery. */
          }
          if (signal.aborted || mustStop(error)) throw error
        } finally {
          pipelines.delete(pipeline)
        }
      }
      if (mode === 'reason') await reason()
      else if (mode === 'verify') {
        if (!sourceRunId || !intentId) throw new StoreError('verify 需要 run_id 和 intent_id')
        const previous = await store.readRun(sourceRunId), candidate = previous.outcomes.find(o => o.intent_id === intentId)
        if (!candidate?.candidate || candidate.state === 'confirmed') throw new StoreError('没有待复核候选，或该候选已经晋升')
        await attempt(intentId, candidate)
      } else if (mode === 'explore') {
        if (!intentId) throw new StoreError('explore 需要 intent_id')
        await attempt(intentId)
      } else {
        const attempted = new Set<string>()
        let reasoning = 0
        while (run.steps < config.orchestration.maxSteps && run.explored < config.orchestration.maxExplore) {
          guard()
          const graph = await store.read()
          if (foundFlag) break
          updateFlagProgress?.()
          if ((stopOnFlag && graph.facts.some(f => f.kind === 'flag' && f.verification_status === 'confirmed' && f.data?.status !== 'rejected')) || (policy.mode === 'count' && (run.flag_progress?.found ?? 0) >= policy.count)) { await stopForFlag(); break }
          if (graph.project.status === 'completed') { run.stop_reason = 'goal-completed'; break }
          const ready = frontier(graph, { fullAccess: options.autoConfirm?.() ?? false, actor }).ready.filter(i => !attempted.has(i.id))
          if (!ready.length) {
            if (frontier(graph, { fullAccess: options.autoConfirm?.() ?? false, actor }).pending_confirmation.length) { run.stop_reason = 'pending-confirmation'; break }
            if (reasoning++ >= config.orchestration.maxSteps || !await reason()) { run.stop_reason = 'no-new-intents'; break }
            continue
          }
          const batch = ready.slice(0, Math.min(config.orchestration.concurrency, config.orchestration.maxSteps - run.steps, config.orchestration.maxExplore - run.explored))
          batch.forEach(i => attempted.add(i.id))
          const previous = (await store.listRuns()).filter(r => r.id !== run.id).reverse()
          const results = await Promise.allSettled(batch.map(i => {
            const budget = i.verification_budget as { candidate_session?: string; attempts?: number } | undefined
            const saved = previous.flatMap(r => r.outcomes).find(o => o.intent_id === i.id && o.candidate && !o.verification && o.state !== 'confirmed' && (budget?.attempts ?? 0) < config.orchestration.maxVerify && (!budget?.candidate_session || budget.candidate_session === o.candidate.explorer_session))
            return attempt(i.id, saved)
          }))
          const rejected = results.find(r => r.status === 'rejected')
          if (rejected?.status === 'rejected') throw rejected.reason
        }
        run.stop_reason ??= (await store.read()).project.status === 'completed' ? 'goal-completed' : 'budget-exhausted'
      }
      guard()
      run.state =
        !foundFlag && run.outcomes.some((o) => o.state === 'failed')
          ? 'failed'
          : 'completed'
      updateFlagProgress?.()
      await store.saveRun(run, runOptions)
      return run
    } catch (error) {
      if (!record) throw error
      record.state = signal.aborted ? 'cancelled' : 'failed'
      record.stop_reason = (error as Error).message
      updateFlagProgress?.()
      const { signal: _cancelled, ...cleanup } = options
      try {
        await store.saveRun(record, cleanup)
      } catch {
        /* Never override revoked write authority for bookkeeping. */
      }
      return record
    } finally {
      clearTimeout(deadline)
      this.active.delete(store.root)
    }
  }
}
