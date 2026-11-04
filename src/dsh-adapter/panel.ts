import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { Config } from '../settings.js'
import { PANEL_REMOTE, actionSchema, type PanelAction, type PanelState } from '../panel/rpc.js'
import { resolveStorePath } from '../store/paths.js'
import { taskCatalog, taskRoot } from '../store/tasks.js'
import { GraphStore } from '../store/graph.js'
import { frontier } from '../render/frontier.js'
import type { TaskResult } from '../panel/result.js'
import type { RunRecord } from '../store/runs.js'
import { UNTRUSTED_NOTICE } from '../render/context.js'
import { StoreError } from '../store/validation.js'

interface Job { agentId: string; goal: string; taskId?: string; next?: { goal: string; purpose: 'solve' | 'writeup' }; activity: Array<{ at: string; stage: string }>; callId: string; started: boolean; drained: Promise<void>; finish(): void; controller: AbortController; state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; error?: string; started_at: string; done?: Promise<void>; result?: TaskResult }
export class TaskPanelService extends TypertRemoteService {
  private jobs = new Map<string, Job>()
  constructor(ctx: Context, private getConfig: () => Config, private alive: () => boolean) {
    super(ctx, 'sapperPanel')
    ctx.effect(() => () => { for (const job of this.jobs.values()) job.controller.abort(new StoreError('Sapper 已卸载')) })
  }
  executionStarted(exec: ToolExecution) { const job = [...this.jobs.values()].find(job => job.callId === String(exec.callId)); if (job) job.started = true }
  executionFinished(exec: ToolExecution) { [...this.jobs.values()].find(job => job.callId === String(exec.callId))?.finish() }
  private owner() {
    if (principalOf(this.ctx.invocation)) throw new StoreError('任务面板仅向 DSH 本机用户开放')
    if (!this.alive() || !this.getConfig().enabled) throw new StoreError('Sapper 已关闭')
  }
  private agent(sessionId: string) {
    this.owner()
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (!agent || !this.ctx.agents.roots().includes(agent) || !agent.session.header.cwd) throw new StoreError('请在 DSH 打开一个普通工作区会话，然后在面板选择它')
    return agent
  }
  @Remote
  async targets() {
    this.owner()
    return this.ctx.agents.roots().filter(a => a.session.header.cwd).map(a => ({ id: String(a.id), cwd: a.session.header.cwd! }))
  }
  @Remote({ resources: { session: (sessionId: string) => SessionId(sessionId) } })
  async state(sessionId: string): Promise<PanelState> {
    const agent = this.agent(sessionId), cwd = agent.session.header.cwd!, base = resolveStorePath(cwd, this.getConfig())!
    const catalog = await taskCatalog(base, cwd), active = catalog?.active ?? 'legacy'
    const store = new GraphStore(taskRoot(base, active), cwd), tasks = [...catalog?.tasks ?? []]
    const legacy = new GraphStore(base, cwd)
    const warnings: string[] = []
    try { if (await legacy.initialized()) { const g = await legacy.read(); tasks.unshift({ id: 'legacy', goal: g.project.goal, created_at: g.project.created_at }) } }
    catch (error) { warnings.push('原工作区图无法读取：' + (error as Error).message) }
    const job = this.jobs.get(base)
    const state: PanelState = { cwd, active, tasks, runs: [], ...(job ? { job: { id: job.callId, state: job.state, started_at: job.started_at, ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: job.result } : {}) } } : {}) }
    try { if (await store.initialized()) {
      const graph = await store.read(); warnings.push(...graph.warnings)
      const f = frontier(graph, { fullAccess: true, actor: String(agent.id) })
      state.graph = { goal: graph.project.goal, status: graph.project.status, facts: graph.facts.filter(f => f.id !== 'goal').length, verified: graph.facts.filter(f => f.verification_status === 'confirmed').length, ready: f.ready.length, integrity: graph.integrity, nodes: [...graph.facts.filter(f => f.id !== 'goal').map(f => ({ id: f.id, title: f.title ?? f.description.slice(0, 50), type: 'fact' as const, status: f.verification_status === 'confirmed' ? 'confirmed' : 'observed', source_intent: f.source_intent })), ...graph.intents.map(i => ({ id: i.id, title: i.title ?? i.description.slice(0, 50), type: 'intent' as const, status: i.status, from: i.from, to: i.to }))].slice(-300) }
      state.runs = (await store.listRuns()).slice(-8).reverse().map(run => ({
        id: run.id, state: run.state, steps: run.steps, explored: run.explored,
        ...(run.stop_reason ? { stop_reason: run.stop_reason } : {}),
        children: run.children ?? [],
        outcomes: run.outcomes.map(o => ({ intent_id: o.intent_id, state: o.state,
          ...(o.error ? { error: o.error } : {}), ...(o.candidate ? { candidate: { title: o.candidate.title, description: o.candidate.description, kind: o.candidate.kind, ...(o.candidate.reproduction ? { reproduction: o.candidate.reproduction } : {}) } } : {}),
          ...(o.verification ? { verification: { verified: o.verification.verified, issues: o.verification.issues } } : {}),
        })),
      }))
    }
    } catch (error) { warnings.push('当前任务图无法读取：' + (error as Error).message) }
    if (warnings.length) state.warnings = [...new Set(warnings)]
    return JSON.parse(JSON.stringify(state)) as PanelState
  }
  @Remote({ resources: { session: (sessionId: string) => SessionId(sessionId) } })
  async action(sessionId: string, input: PanelAction) {
    return this.submit(this.agent(sessionId), input)
  }
  /** Shared command/panel launcher. Acknowledgement never waits for model or tool work. */
  submit(agent: Agent, input: PanelAction) {
    this.owner()
    if (this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) throw new StoreError('需要当前工作区的普通 DSH 会话')
    const args = actionSchema.parse(input), base = resolveStorePath(agent.session.header.cwd, this.getConfig())
    if (!base) throw new StoreError('需要当前 DSH 工作区路径')
    const current = this.jobs.get(base)
    if (args.action === 'cancel') {
      if (!current || (current.state !== 'running' && current.state !== 'cancelling')) return { accepted: false, state: 'idle' }
      delete current.next
      current.state = 'cancelling'
      current.controller.abort(new StoreError('用户取消任务'))
      return { accepted: true, job_id: current.callId, state: current.state }
    }
    if (args.action === 'steer') {
      if (!args.goal?.trim()) throw new StoreError('请输入新的探索方向')
      if (!current || current.state !== 'running') throw new StoreError('当前没有正在运行的任务；结束后用 /sapper continue 或 /sapper retry')
      if (current.agentId !== String(agent.id)) throw new StoreError('请从发起任务的主会话调整方向')
      const nextGoal = `原任务：${current.goal}\n用户调整方向：${args.goal.trim()}`
      if (nextGoal.length > 8000) throw new StoreError('合并后的任务目标最多 8000 字符，请缩短新方向')
      current.next = { goal: nextGoal, purpose: 'solve' }
      current.state = 'cancelling'
      current.controller.abort(new StoreError('用户调整方向，正在停止原路线'))
      this.notice(agent, current, 'direction', `已收到新方向：${args.goal.trim()}。停止并回收原路线后自动继续。`)
      return { accepted: true, job_id: current.callId, state: 'cancelling' }
    }
    if (current?.state === 'running' || current?.state === 'cancelling') throw new StoreError('当前工作区已有任务运行；用 /sapper job 查看或 /sapper cancel 取消')
    if (args.action === 'start' && !args.goal?.trim()) throw new StoreError('请输入任务目标')
    let finish!: () => void
    const drained = new Promise<void>(resolve => { finish = resolve })
    const job: Job = { agentId: String(agent.id), goal: args.goal?.trim() ?? '', activity: [], callId: randomUUID(), started: false, drained, finish, controller: new AbortController(), state: 'running', started_at: new Date().toISOString() }
    this.jobs.set(base, job)
    this.notice(agent, job, 'accepted', `任务已受理：${args.goal?.trim() || '继续当前工作区任务'}。可用 /sapper steer <方向> 调整、/sapper cancel 停止；结束后用 /sapper wp 或 /sapper retry。`)
    // The job owns cancellation and drains the tool body even if the caller leaves the page.
    const execution = args.action === 'run'
      ? { name: 'sapper_dispatch', arguments: { mode: 'run' } }
      : { name: 'sapper_task', arguments: args }
    job.done = this.ctx.tools.execute({ ...execution, agent, callId: ToolCallId(job.callId), signal: job.controller.signal }).then(async result => {
      if (job.started) await job.drained
      if (result.isError) throw new StoreError(result.error.message)
      const run = result.value as { state?: string; stop_reason?: string; task_id?: string; id?: string }
      try { job.result = await this.result(agent, job.callId, run.task_id, run.id); job.result.activity = job.activity; this.deliver(agent, job.result) } catch (error) { this.ctx.logger.warn('Sapper 结果回传失败：%s', (error as Error).message) }
      job.state = run.state === 'cancelled' ? 'cancelled' : run.state === 'failed' ? 'failed' : 'completed'
      if (run.stop_reason && job.state !== 'completed') job.error = run.stop_reason
    }).catch(async error => { if (job.started) await job.drained; job.state = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = (error as Error).message; job.result = { job_id: job.callId, task_id: 'unknown', goal: args.goal ?? '', state: job.state, summary: `Sapper 启动/运行失败：${job.error}`, confirmed: [], candidates: [], errors: [job.error] }; try { if (job.taskId) job.result = { ...await this.result(agent, job.callId, job.taskId), activity: job.activity }; this.deliver(agent, job.result) } catch {} })
    job.done = job.done.then(() => {
      if (!job.next || this.jobs.get(base) !== job || !this.alive() || !this.getConfig().enabled) return
      const next = job.next; delete job.next
      this.submit(agent, { action: 'continue', goal: next.goal, purpose: next.purpose, ...(job.taskId ? { task_id: job.taskId } : {}) })
    }).catch(error => { job.error = (error as Error).message; this.notice(agent, job, 'result', `新方向启动失败：${job.error}`) })
    return { accepted: true, job_id: job.callId, state: job.state }
  }
  private notice(agent: Agent, job: Job, phase: NonNullable<TaskResult['phase']>, summary: string, extra: Partial<TaskResult> = {}) {
    job.activity.push({ at: new Date().toISOString(), stage: summary }); job.activity = job.activity.slice(-40)
    this.deliver(agent, { job_id: job.callId, task_id: job.taskId ?? 'pending', goal: job.goal, state: job.state, summary, confirmed: [], candidates: [], errors: [], activity: [...job.activity], phase, ...extra })
  }
  async progress(agent: Agent, root: string, run: RunRecord, stage: string) {
    const base = resolveStorePath(agent.session.header.cwd, this.getConfig())
    const job = base && this.jobs.get(base)
    if (!job || job.agentId !== String(agent.id) || job.state !== 'running' || job.controller.signal.aborted) return
    if (!job.goal) job.goal = (await new GraphStore(root, agent.session.header.cwd!).read()).project.goal
    job.taskId = root === base ? 'legacy' : root.split(/[\\/]/).at(-1)!
    const labels: Record<string, string> = { reason: '正在规划下一步', explore: '正在探索并收集证据', verify: '正在独立复核', 'flag-found': '发现带工具证据的 flag，已停止其他路线，正在保存和回收子会话' }
    this.notice(agent, job, stage === 'flag-found' ? 'flag-found' : 'progress', labels[stage] ?? stage, {
      run_id: run.id, candidates: run.outcomes.filter(o => o.candidate && o.state !== 'confirmed').map(o => ({ title: o.candidate!.title, description: o.candidate!.description, kind: o.candidate!.kind, status: 'unverified' as const })),
    })
  }
  async result(agent: Agent, jobId: string, selected?: string, runId?: string): Promise<TaskResult> {
    const cwd = agent.session.header.cwd!, base = resolveStorePath(cwd, this.getConfig())!
    const catalog = await taskCatalog(base, cwd), taskId = selected ?? catalog?.active ?? 'legacy'
    const store = new GraphStore(taskRoot(base, taskId), cwd), graph = await store.read()
    const run: RunRecord | undefined = runId ? await store.readRun(runId) : (await store.listRuns()).at(-1)
    const confirmed = graph.facts.filter(f => f.verification_status === 'confirmed' && (f.kind === 'flag' || run?.outcomes.some(o => o.fact_id === f.id))).map(f => ({ id: f.id, title: f.title ?? f.id, description: f.description, kind: f.kind ?? 'note' }))
    const candidates = (run?.outcomes ?? []).filter(o => o.candidate && o.state !== 'confirmed' && !confirmed.some(f => f.kind === o.candidate!.kind && f.description === o.candidate!.description)).map(o => ({ title: o.candidate!.title, description: o.candidate!.description, kind: o.candidate!.kind, status: o.verification?.verified === false ? 'rejected' as const : 'unverified' as const }))
    const errors = [...new Set((run?.outcomes ?? []).flatMap(o => o.error ? [o.error] : []))]
    const summary = `${run?.stop_reason === 'flag-found' ? '发现 flag，已按约束结束本轮。候选状态与独立复核状态见下方。' : graph.project.status === 'completed' ? '目标已独立复核完成。' : '本轮已结束，目标仍待完成。'}\n${graph.project.goal}\n已确认结果 ${confirmed.length} 项；未确认候选 ${candidates.length} 项。${run?.stop_reason ? '\n停止原因：' + run.stop_reason : ''}`
    return { phase: 'result', job_id: jobId, task_id: taskId, ...(run ? { run_id: run.id, stop_reason: run.stop_reason ?? '' } : {}), goal: graph.project.goal, state: run?.state ?? graph.project.status, summary, confirmed, candidates, errors }
  }
  private deliver(agent: Agent, result: TaskResult) {
    agent.session.append('sapper/result', result)
    const text = UNTRUSTED_NOTICE + '\n' + JSON.stringify(result)
    // Frequent stage cards are visible events; only acceptance, direction and final results enter model context.
    if (result.phase === 'progress') return
    agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'sapper-dsh', form: 'result', sections: [{ name: 'Sapper task result', text }] } }))
  }
  @Remote({ resources: { session: (sessionId: string) => SessionId(sessionId) } })
  async report(sessionId: string) { const agent = this.agent(sessionId), result = await this.result(agent, 'report-' + randomUUID()); this.deliver(agent, result); return result }
  async whenIdle(cwd: string) { const base = resolveStorePath(cwd, this.getConfig()); if (!base) return; for (;;) { const job = this.jobs.get(base); await job?.done; if (this.jobs.get(base) === job) return } }
}
export function registerTaskPanel(ctx: Context, getConfig: () => Config, alive: () => boolean) {
  const service = new TaskPanelService(ctx, getConfig, alive)
  ctx.inject(['typert'], child => {
    child.effect(() => child.typert.register({ package: 'sapper-dsh', face: 'host', model: { services: [], events: [], objects: [] }, schemas: [], invocations: PANEL_REMOTE.descriptors }))
  })
  return service
}
