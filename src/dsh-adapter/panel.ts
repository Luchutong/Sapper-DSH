import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { Config } from '../settings.js'
import { PANEL_REMOTE, actionSchema, type PanelAction, type PanelState } from '../panel/rpc.js'
import { resolveStorePath } from '../store/paths.js'
import { taskCatalog, taskRoot } from '../store/tasks.js'
import { GraphStore } from '../store/graph.js'
import { frontier } from '../render/frontier.js'
import { StoreError } from '../store/validation.js'

interface Job { callId: string; started: boolean; drained: Promise<void>; finish(): void; controller: AbortController; state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; error?: string; started_at: string; done?: Promise<void> }
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
    const state: PanelState = { cwd, active, tasks, runs: [], ...(job ? { job: { id: job.callId, state: job.state, started_at: job.started_at, ...(job.error ? { error: job.error } : {}) } } : {}) }
    try { if (await store.initialized()) {
      const graph = await store.read(); warnings.push(...graph.warnings)
      const f = frontier(graph, { fullAccess: true, actor: String(agent.id) })
      state.graph = { goal: graph.project.goal, status: graph.project.status, facts: graph.facts.filter(f => f.id !== 'goal').length, verified: graph.facts.filter(f => f.verification_status === 'confirmed').length, ready: f.ready.length, integrity: graph.integrity }
      state.runs = (await store.listRuns()).slice(-8).reverse().map(run => ({
        id: run.id, state: run.state, steps: run.steps, explored: run.explored,
        ...(run.stop_reason ? { stop_reason: run.stop_reason } : {}),
        children: (run.children ?? []).map(c => ({ role: c.role })),
        outcomes: run.outcomes.map(o => ({ intent_id: o.intent_id, state: o.state,
          ...(o.error ? { error: o.error } : {}), ...(o.candidate ? { candidate: { title: o.candidate.title } } : {}),
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
      current.state = 'cancelling'
      current.controller.abort(new StoreError('用户取消任务'))
      return { accepted: true, job_id: current.callId, state: current.state }
    }
    if (current?.state === 'running' || current?.state === 'cancelling') throw new StoreError('当前工作区已有任务运行；用 /sapper job 查看或 /sapper cancel 取消')
    if (args.action === 'start' && !args.goal?.trim()) throw new StoreError('请输入任务目标')
    let finish!: () => void
    const drained = new Promise<void>(resolve => { finish = resolve })
    const job: Job = { callId: randomUUID(), started: false, drained, finish, controller: new AbortController(), state: 'running', started_at: new Date().toISOString() }
    this.jobs.set(base, job)
    // The job owns cancellation and drains the tool body even if the caller leaves the page.
    const execution = args.action === 'run'
      ? { name: 'sapper_dispatch', arguments: { mode: 'run' } }
      : { name: 'sapper_task', arguments: args }
    job.done = this.ctx.tools.execute({ ...execution, agent, callId: ToolCallId(job.callId), signal: job.controller.signal }).then(async result => {
      if (job.started) await job.drained
      if (result.isError) throw new StoreError(result.error.message)
      const run = result.value as { state?: string; stop_reason?: string }
      job.state = run.state === 'cancelled' ? 'cancelled' : run.state === 'failed' ? 'failed' : 'completed'
      if (run.stop_reason && job.state !== 'completed') job.error = run.stop_reason
    }).catch(async error => { if (job.started) await job.drained; job.state = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = (error as Error).message })
    return { accepted: true, job_id: job.callId, state: job.state }
  }
  async whenIdle(cwd: string) { const base = resolveStorePath(cwd, this.getConfig()); if (base) await this.jobs.get(base)?.done }
}
export function registerTaskPanel(ctx: Context, getConfig: () => Config, alive: () => boolean) {
  const service = new TaskPanelService(ctx, getConfig, alive)
  ctx.inject(['typert'], child => {
    child.effect(() => child.typert.register({ package: 'sapper-dsh', face: 'host', model: { services: [], events: [], objects: [] }, schemas: [], invocations: PANEL_REMOTE.descriptors }))
  })
  return service
}
