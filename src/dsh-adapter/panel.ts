import type { Context } from '@deepseek-ai/cordis'
import {
  Remote,
  TypertRemoteService,
  principalOf,
} from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import path from 'node:path'
import { exists } from '../store/io.js'
import { randomUUID } from 'node:crypto'
import type { Config } from '../settings.js'
import {
  PANEL_REMOTE,
  actionSchema,
  type PanelAction,
  type PanelState,
} from '../panel/rpc.js'
import { resolveStorePath } from '../store/paths.js'
import { taskCatalog, taskRoot } from '../store/tasks.js'
import { GraphStore } from '../store/graph.js'
import { frontier } from '../render/frontier.js'
import { RESULT_RECORD, type TaskResult } from '../panel/result.js'
import type { RunRecord } from '../store/runs.js'
import { UNTRUSTED_NOTICE } from '../render/context.js'
import { WorkbenchStore } from '../workbench/store.js'
import { Briefs } from '../workbench/briefs.js'
import {
  addressSchema,
  launchSchema,
  preferencesSchema,
  type JobRecord,
  type LaunchInput,
  type Preferences,
  type TaskAddress,
} from '../workbench/contracts.js'
import { archiveWriteup } from '../workbench/artifacts.js'
import { writePermission } from './permissions.js'
import { NativeWorkbench } from '../workbench/native.js'
import { StoreError } from '../store/validation.js'

interface Job {
  input: PanelAction
  settle(): void
  agentId: string
  goal: string
  taskId?: string
  next?: { goal: string; purpose: 'solve' | 'writeup' }
  activity: Array<{ at: string; stage: string }>
  callId: string
  started: boolean
  drained: Promise<void>
  finish(): void
  controller: AbortController
  state: import('../workbench/contracts.js').JobState
  error?: string
  started_at: string
  done?: Promise<void>
  result?: TaskResult
}
export class TaskPanelService extends TypertRemoteService {
  private jobs = new Map<string, Job>()
  readonly workbench: WorkbenchStore
  readonly briefs: Briefs
  readonly native: NativeWorkbench
  private closed = false
  private pumping = false
  private launches = new Map<string, string>()
  constructor(
    ctx: Context,
    private getConfig: () => Config,
    private alive: () => boolean,
  ) {
    super(ctx, 'sapperPanel')
    this.workbench = new WorkbenchStore(ctx, () => {
      void this.restore()
    })
    this.briefs = new Briefs(ctx, this.workbench)
    this.native = new NativeWorkbench(
      ctx,
      this,
      (cwd) => resolveStorePath(cwd, this.getConfig())!,
    )
    ctx.on('loader/volatile-update',()=>{void this.pump()})
    ctx.inject(['sessionController'], () => {
      void this.workbench.ready.then(() => this.restore())
    })
    ctx.effect(() => async () => {
      this.closed = true
      for (const job of this.jobs.values()) {
        if (job.state === 'queued') job.settle()
        else job.controller.abort(new StoreError('Sapper 已卸载'))
      }
      await Promise.allSettled([...this.jobs.values()].map((j) => j.done))
    })
  }
  @Remote
  async overview() {
    this.owner()
    return this.native.overview()
  }
  @Remote
  async preferences(input: Preferences) {
    this.owner()
    return this.native.preferences(preferencesSchema.parse(input))
  }
  @Remote
  async launch(input: LaunchInput) {
    this.owner()
    return this.native.launch(launchSchema.parse(input))
  }
  @Remote
  async detail(input: TaskAddress) {
    this.owner()
    return this.native.detail(addressSchema.parse(input))
  }
  @Remote
  async taskAction(input: TaskAddress, action: PanelAction) {
    this.owner()
    return this.native.taskAction(
      addressSchema.parse(input),
      actionSchema.parse(action),
    )
  }
  @Remote
  async file(input: TaskAddress, name: string) {
    this.owner()
    return this.native.file(addressSchema.parse(input), name)
  }
  @Remote
  async node(input: TaskAddress, id: string) {
    this.owner()
    return this.native.node(addressSchema.parse(input), id)
  }
  @Remote
  async seen(id: string) {
    this.owner()
    return this.native.seen(id)
  }
  @Remote
  async retryBrief(jobId: string) {
    this.owner()
    return this.briefs.retry(jobId)
  }
  executionStarted(exec: ToolExecution) {
    const job = [...this.jobs.values()].find(
      (job) => job.callId === String(exec.callId),
    )
    if (job) job.started = true
  }
  executionFinished(exec: ToolExecution) {
    ;[...this.jobs.values()]
      .find((job) => job.callId === String(exec.callId))
      ?.finish()
  }
  private owner() {
    if (principalOf(this.ctx.invocation))
      throw new StoreError('任务面板仅向 DSH 本机用户开放')
    if (!this.alive() || !this.getConfig().enabled)
      throw new StoreError('Sapper 已关闭')
  }
  private agent(sessionId: string) {
    this.owner()
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (
      !agent ||
      !this.ctx.agents.roots().includes(agent) ||
      !agent.session.header.cwd
    )
      throw new StoreError('请在 DSH 打开一个普通工作区会话，然后在面板选择它')
    return agent
  }
  @Remote
  async targets() {
    this.owner()
    return this.ctx.agents
      .roots()
      .filter((a) => a.session.header.cwd)
      .map((a) => ({ id: String(a.id), cwd: a.session.header.cwd! }))
  }
  @Remote({
    resources: { session: (sessionId: string) => SessionId(sessionId) },
  })
  async state(sessionId: string): Promise<PanelState> {
    const agent = this.agent(sessionId)
    return this.readState(agent.session.header.cwd!, sessionId)
  }
  async readState(
    cwd: string,
    sessionId: string,
    selected?: string,
    runId?: string,
  ): Promise<PanelState> {
    const base = resolveStorePath(cwd, this.getConfig())!
    const catalog = await taskCatalog(base, cwd),
      active = selected ?? catalog?.active ?? 'legacy'
    const store = new GraphStore(taskRoot(base, active), cwd),
      tasks = [...(catalog?.tasks ?? [])]
    const legacy = new GraphStore(base, cwd)
    const warnings: string[] = []
    try {
      if (await legacy.initialized()) {
        const g = await legacy.read()
        tasks.unshift({
          id: 'legacy',
          goal: g.project.goal,
          created_at: g.project.created_at,
        })
      }
    } catch (error) {
      warnings.push('原工作区图无法读取：' + (error as Error).message)
    }
    const currentJob = this.jobs.get(base)
    const job =
      currentJob &&
      (!selected ||
        currentJob.taskId === selected ||
        currentJob.input.task_id === selected)
        ? currentJob
        : undefined
    const state: PanelState = {
      cwd,
      active,
      tasks,
      runs: [],
      ...(job
        ? {
            job: {
              id: job.callId,
              state: job.state,
              started_at: job.started_at,
              ...(job.error ? { error: job.error } : {}),
              ...(job.result ? { result: job.result } : {}),
            },
          }
        : {}),
    }
    try {
      if (await store.initialized()) {
        const graph = await store.read()
        warnings.push(...graph.warnings)
        const f = frontier(graph, { fullAccess: true, actor: sessionId })
        state.graph = {
          goal: graph.project.goal,
          status: graph.project.status,
          facts: graph.facts.filter((f) => f.id !== 'goal').length,
          verified: graph.facts.filter(
            (f) => f.verification_status === 'confirmed',
          ).length,
          ready: f.ready.length,
          integrity: graph.integrity,
          nodes: [
            ...graph.facts
              .filter((f) => f.id !== 'goal')
              .map((f) => ({
                id: f.id,
                title: f.title ?? f.description.slice(0, 50),
                type: 'fact' as const,
                status:
                  f.verification_status === 'confirmed'
                    ? 'confirmed'
                    : 'observed',
                source_intent: f.source_intent,
              })),
            ...graph.intents.map((i) => ({
              id: i.id,
              title: i.title ?? i.description.slice(0, 50),
              type: 'intent' as const,
              status: i.status,
              from: i.from,
              to: i.to,
            })),
          ].slice(-300),
        }
        state.runs = (await store.listRuns())
          .filter((r) => !runId || r.id === runId)
          .slice(-8)
          .reverse()
          .map((run) => ({
            id: run.id,
            state: run.state,
            steps: run.steps,
            explored: run.explored,
            ...(run.stop_reason ? { stop_reason: run.stop_reason } : {}),
            children: run.children ?? [],
            outcomes: run.outcomes.map((o) => ({
              intent_id: o.intent_id,
              state: o.state,
              ...(o.error ? { error: o.error } : {}),
              ...(o.candidate
                ? {
                    candidate: {
                      title: o.candidate.title,
                      description: o.candidate.description,
                      kind: o.candidate.kind,
                      ...(o.candidate.reproduction
                        ? { reproduction: o.candidate.reproduction }
                        : {}),
                    },
                  }
                : {}),
              ...(o.verification
                ? {
                    verification: {
                      verified: o.verification.verified,
                      issues: o.verification.issues,
                    },
                  }
                : {}),
            })),
          }))
      }
    } catch (error) {
      warnings.push('当前任务图无法读取：' + (error as Error).message)
    }
    if (warnings.length) state.warnings = [...new Set(warnings)]
    return JSON.parse(JSON.stringify(state)) as PanelState
  }
  @Remote({
    resources: { session: (sessionId: string) => SessionId(sessionId) },
  })
  async action(sessionId: string, input: PanelAction) {
    return this.submit(this.agent(sessionId), input)
  }
  /** Shared command/panel launcher. Acknowledgement never waits for model or tool work. */
  submit(agent: Agent, input: PanelAction) {
    this.owner()
    if (
      this.ctx.agents.get(agent.id) !== agent ||
      !this.ctx.agents.roots().includes(agent)
    )
      throw new StoreError('需要当前工作区的普通 DSH 会话')
    const args = actionSchema.parse(input),
      base = resolveStorePath(agent.session.header.cwd, this.getConfig())
    if (!base) throw new StoreError('需要当前 DSH 工作区路径')
    const current = this.jobs.get(base)
    if (args.action === 'cancel') {
      if (
        !current ||
        !['queued', 'running', 'cancelling'].includes(current.state)
      )
        return { accepted: false, state: 'idle' }
      delete current.next
      if (current.state === 'queued') {
        current.state = 'cancelled'
        current.controller.abort(new StoreError('已取消排队'))
        current.settle()
        void this.persist(current)
        this.notice(agent, current, 'result', '排队任务已取消，未启动模型')
        return { accepted: true, job_id: current.callId, state: current.state }
      }
      current.state = 'cancelling'
      current.controller.abort(new StoreError('用户取消任务'))
      void this.persist(current)
      return { accepted: true, job_id: current.callId, state: current.state }
    }
    if (args.action === 'steer') {
      if (!args.goal?.trim()) throw new StoreError('请输入新的探索方向')
      if (!current || current.state !== 'running')
        throw new StoreError(
          '当前没有正在运行的任务；结束后用 /sapper continue 或 /sapper retry',
        )
      if (current.agentId !== String(agent.id))
        throw new StoreError('请从发起任务的主会话调整方向')
      const nextGoal = `原任务：${current.goal}\n用户调整方向：${args.goal.trim()}`
      if (nextGoal.length > 8000)
        throw new StoreError('合并后的任务目标最多 8000 字符，请缩短新方向')
      current.next = { goal: nextGoal, purpose: 'solve' }
      current.state = 'cancelling'
      current.controller.abort(new StoreError('用户调整方向，正在停止原路线'))
      void this.persist(current)
      this.notice(
        agent,
        current,
        'direction',
        `已收到新方向：${args.goal.trim()}。停止并回收原路线后自动继续。`,
      )
      return { accepted: true, job_id: current.callId, state: 'cancelling' }
    }
    if (current && ['queued', 'running', 'cancelling'].includes(current.state))
      throw new StoreError(
        '当前工作区已有任务运行；用 /sapper job 查看或 /sapper cancel 取消',
      )
    const launchId = this.launches.get(String(agent.id))
    if (launchId && current?.callId === launchId)
      return { accepted: true, job_id: current.callId, state: current.state }
    if (
      args.action === 'verify' &&
      (!args.run_id || !args.intent_id || !args.task_id)
    )
      throw new StoreError('独立复核需要 task_id、run_id 和 intent_id')
    if (args.action === 'start' && !args.goal?.trim())
      throw new StoreError('请输入任务目标')
    const job = this.makeJob(agent, args, this.launches.get(String(agent.id)))
    this.jobs.set(base, job)
    this.notice(
      agent,
      job,
      'accepted',
      `任务已受理：${args.goal?.trim() || '继续当前工作区任务'}。后台排队/执行，输入框可继续使用。`,
    )
    void this.persist(job)
      .then(() => this.pump())
      .catch((error) => {
        job.state = 'failed'
        job.error = (error as Error).message
        job.settle()
      })
    return { accepted: true, job_id: job.callId, state: job.state }
  }
  private makeJob(
    agent: Agent,
    input: PanelAction,
    id: string = randomUUID(),
    saved?: JobRecord,
  ): Job {
    let finish!: () => void, settle!: () => void
    const drained = new Promise<void>((resolve) => {
        finish = resolve
      }),
      done = new Promise<void>((resolve) => {
        settle = resolve
      })
    const controller = new AbortController()
    this.briefs.backgroundSignals.add(controller.signal)
    return {
      input,
      agentId: String(agent.id),
      goal: saved?.goal ?? input.goal?.trim() ?? '',
      activity: [],
      callId: id,
      started: false,
      drained,
      finish,
      controller,
      state: 'queued',
      started_at: saved?.createdAt ?? new Date().toISOString(),
      done,
      settle,
      ...(saved?.taskId ? { taskId: saved.taskId } : {}),
    }
  }
  private record(job: Job): JobRecord {
    const agent = this.ctx.agents.get(SessionId(job.agentId))
    const previous = this.workbench.snapshot().jobs[job.callId]
    return {
      id: job.callId,
      sessionId: job.agentId,
      cwd: agent?.session.header.cwd ?? previous?.cwd ?? '',
      input: job.input,
      goal: job.goal,
      state: job.state,
      createdAt: job.started_at,
      ...(job.activity.at(-1) ? { stage: job.activity.at(-1)!.stage } : {}),
      ...(job.taskId ? { taskId: job.taskId } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}),
      ...(job.next ? { next: job.next } : {}),
    }
  }
  private persist(job: Job) {
    const record = this.record(job)
    return this.workbench.change((d) => {
      d.jobs[job.callId] = record
    })
  }
  async resolveAgent(id: string) {
    let agent = this.ctx.agents.get(SessionId(id))
    if (!agent) {
      const found = await this.ctx
        .get('sessionController')
        ?.resolveAgent(SessionId(id))
      if (found && 'agent' in found) agent = found.agent
      else if (found && 'error' in found)
        throw new StoreError('恢复主会话失败：' + found.error.message)
    }
    if (!agent || !this.ctx.agents.roots().includes(agent))
      throw new StoreError('主会话不可用，请重新打开')
    return agent
  }
  private async restore() {
    for (const record of Object.values(this.workbench.snapshot().jobs).filter(
      (j) => j.state === 'queued',
    )) {
      try {
        const agent = await this.resolveAgent(record.sessionId),
          base = resolveStorePath(record.cwd, this.getConfig())!
        if (!this.jobs.has(base))
          this.jobs.set(
            base,
            this.makeJob(agent, record.input, record.id, record),
          )
      } catch (error) {
        this.ctx.logger.warn(
          'Sapper 队列等待会话恢复：%s',
          (error as Error).message,
        )
      }
    }
    await this.pump()
  }
  async pump() {
    if (this.pumping || this.closed || !this.alive() || !this.getConfig().enabled) return
    this.pumping = true
    try {
      await this.workbench.flush()
      while (
        !this.closed && this.alive() && this.getConfig().enabled &&
        [...this.jobs.values()].filter(
          (j) => j.state === 'running' || j.state === 'cancelling',
        ).length < this.workbench.snapshot().preferences.parallelism
      ) {
        const next = [...this.jobs.values()]
          .filter((j) => j.state === 'queued')
          .sort((a, b) => a.started_at.localeCompare(b.started_at))[0]
        if (!next) break
        next.state = 'running'
        await this.persist(next)
        void this.runJob(next)
      }
    } finally {
      this.pumping = false
    }
  }
  private async runJob(job: Job) {
    const base = resolveStorePath(this.record(job).cwd, this.getConfig())!
    const args = job.input
    let agent: Agent | undefined
    try {
      agent = await this.resolveAgent(job.agentId)
      const execution =
        args.action === 'run'
          ? { name: 'sapper_dispatch', arguments: { mode: 'run' } }
          : { name: 'sapper_task', arguments: args }
      const result = await this.ctx.tools.execute({
        ...execution,
        agent,
        callId: ToolCallId(job.callId),
        signal: job.controller.signal,
      })
      if (job.started) await job.drained
      if (result.isError) throw new StoreError(result.error.message)
      const run = result.value as {
        state?: string
        stop_reason?: string
        task_id?: string
        id?: string
      }
      job.result = await this.result(agent, job.callId, run.task_id, run.id)
      job.result.activity = job.activity
      if (run.task_id && run.id)
        try {
          const store = new GraphStore(
            taskRoot(base, run.task_id),
            agent.session.header.cwd!,
          )
          const owner = agent
          let permission: string | undefined
          await archiveWriteup(store, run.id, agent.session.header.cwd!, () => {
            job.controller.signal.throwIfAborted()
            const current = writePermission(
              this.ctx,
              { agent: owner },
              store.root,
            ).fingerprint
            if (
              !this.alive() ||
              !this.getConfig().enabled ||
              (permission !== undefined && current !== permission)
            )
              throw new StoreError('权限或运行状态已变化，WP 归档停止')
            permission = current
          })
        } catch (error) {
          job.result.errors.push('WP 历史归档：' + (error as Error).message)
        }
      job.state =
        run.state === 'cancelled'
          ? 'cancelled'
          : run.state === 'failed'
            ? 'failed'
            : 'completed'
      if (run.stop_reason && job.state !== 'completed')
        job.error = run.stop_reason
      this.deliver(agent, job.result)
    } catch (error) {
      if (job.started) await job.drained
      job.state = this.closed
        ? 'interrupted'
        : job.controller.signal.aborted
          ? 'cancelled'
          : 'failed'
      job.error = (error as Error).message
      job.result = {
        phase: 'result',
        job_id: job.callId,
        task_id: job.taskId ?? 'unknown',
        goal: job.goal,
        state: job.state,
        summary: `Sapper 运行结束：${job.error}`,
        confirmed: [],
        candidates: [],
        errors: [job.error],
      }
      if (agent)
        try {
          if (job.taskId)
            job.result = {
              ...(await this.result(agent, job.callId, job.taskId)),
              activity: job.activity,
            }
          this.deliver(agent, job.result)
        } catch {}
    } finally {
      try {
        await this.persist(job)
        if (agent && job.result && !job.next && !this.closed)
          await this.briefs.enqueue(agent, job.result)
        if (
          agent &&
          job.next &&
          this.jobs.get(base) === job &&
          !this.closed &&
          this.alive() &&
          this.getConfig().enabled
        ) {
          const next = job.next
          delete job.next
          this.submit(agent, {
            action: 'continue',
            goal: next.goal,
            purpose: next.purpose,
            ...(job.taskId ? { task_id: job.taskId } : {}),
          })
        }
      } catch (error) {
        this.ctx.logger.warn(
          'Sapper 队列结算失败：%s',
          (error as Error).message,
        )
      }
      job.settle()
      void this.pump()
    }
  }
  async startNative(agent: Agent, goal: string, requestId: string) {
    const old = this.workbench.snapshot().jobs[requestId]
    if (old) return old.id
    // commands is optional and registered in its own injection scope. The panel
    // belongs to the plugin scope, so a direct property read throws in Loader.
    const commands = this.ctx.get('commands')
    if (!commands) throw new StoreError('DSH 命令服务尚未就绪，请稍后继续创建')
    this.launches.set(String(agent.id), requestId)
    try {
      const command = await commands.execute(
        agent,
        '/sapper start ' + goal,
        [],
        new AbortController().signal,
      )
      if (!command || command.result.kind !== 'success')
        throw new StoreError(command?.result.text ?? 'Sapper 命令不可用')
      await this.workbench.flush()
      if (!this.workbench.snapshot().jobs[requestId])
        throw new StoreError('任务受理未能持久化，请重试同一请求')
      return requestId
    } finally {
      this.launches.delete(String(agent.id))
    }
  }
  private notice(
    agent: Agent,
    job: Job,
    phase: NonNullable<TaskResult['phase']>,
    summary: string,
    extra: Partial<TaskResult> = {},
  ) {
    job.activity.push({ at: new Date().toISOString(), stage: summary })
    job.activity = job.activity.slice(-40)
    void this.persist(job).catch((error) =>
      this.ctx.logger.warn('Sapper 进度保存失败：%s', String(error)),
    )
    this.deliver(agent, {
      job_id: job.callId,
      task_id: job.taskId ?? 'pending',
      goal: job.goal,
      state: job.state,
      summary,
      confirmed: [],
      candidates: [],
      errors: [],
      activity: [...job.activity],
      phase,
      ...extra,
    })
  }
  async progress(agent: Agent, root: string, run: RunRecord, stage: string) {
    const base = resolveStorePath(agent.session.header.cwd, this.getConfig())
    const job = base && this.jobs.get(base)
    if (
      !job ||
      job.agentId !== String(agent.id) ||
      job.state !== 'running' ||
      job.controller.signal.aborted
    )
      return
    if (!job.goal)
      job.goal = (
        await new GraphStore(root, agent.session.header.cwd!).read()
      ).project.goal
    job.taskId = root === base ? 'legacy' : root.split(/[\\/]/).at(-1)!
    const labels: Record<string, string> = {
      reason: '正在规划下一步',
      explore: '正在探索并收集证据',
      verify: '正在独立复核',
      'flag-found':
        '发现带工具证据的 flag，已停止其他路线，正在保存和回收子会话',
    }
    await this.persist(job)
    this.notice(
      agent,
      job,
      stage === 'flag-found' ? 'flag-found' : 'progress',
      labels[stage] ?? stage,
      {
        run_id: run.id,
        candidates: run.outcomes
          .filter((o) => o.candidate && o.state !== 'confirmed')
          .map((o) => ({
            title: o.candidate!.title,
            description: o.candidate!.description,
            kind: o.candidate!.kind,
            status: 'unverified' as const,
          })),
      },
    )
  }
  async result(
    agent: Agent,
    jobId: string,
    selected?: string,
    runId?: string,
  ): Promise<TaskResult> {
    return this.resultAt(agent.session.header.cwd!, jobId, selected, runId)
  }
  async resultAt(
    cwd: string,
    jobId: string,
    selected?: string,
    runId?: string,
  ): Promise<TaskResult> {
    const base = resolveStorePath(cwd, this.getConfig())!
    const catalog = await taskCatalog(base, cwd),
      taskId = selected ?? catalog?.active ?? 'legacy'
    const store = new GraphStore(taskRoot(base, taskId), cwd),
      graph = await store.read()
    const run: RunRecord | undefined = runId
      ? await store.readRun(runId)
      : (await store.listRuns()).at(-1)
    const confirmed = graph.facts
      .filter(
        (f) =>
          f.verification_status === 'confirmed' &&
          ((f.kind === 'flag' && (!run || f.created_at <= run.updated_at)) ||
            run?.outcomes.some((o) => o.fact_id === f.id)),
      )
      .map((f) => ({
        id: f.id,
        title: f.title ?? f.id,
        description: f.description,
        kind: f.kind ?? 'note',
      }))
    const candidates = (run?.outcomes ?? [])
      .filter(
        (o) =>
          o.candidate &&
          o.state !== 'confirmed' &&
          !confirmed.some(
            (f) =>
              f.kind === o.candidate!.kind &&
              f.description === o.candidate!.description,
          ),
      )
      .map((o) => ({
        title: o.candidate!.title,
        description: o.candidate!.description,
        kind: o.candidate!.kind,
        status:
          o.verification?.verified === false
            ? ('rejected' as const)
            : ('unverified' as const),
      }))
    const wp_path =
      graph.project.purpose === 'writeup' &&
      (await exists(path.join(cwd, 'WP.md')))
        ? path.join(cwd, 'WP.md')
        : undefined
    const errors = [
      ...new Set(
        (run?.outcomes ?? []).flatMap((o) => (o.error ? [o.error] : [])),
      ),
    ]
    const summary = `${run?.stop_reason === 'flag-found' ? '发现 flag，已按约束结束本轮。候选状态与独立复核状态见下方。' : (run ? run.stop_reason === 'goal-completed' : graph.project.status === 'completed') ? '目标已独立复核完成。' : '本轮已结束，目标仍待完成。'}\n${graph.project.goal}\n已确认结果 ${confirmed.length} 项；未确认候选 ${candidates.length} 项。${run?.stop_reason ? '\n停止原因：' + run.stop_reason : ''}`
    return {
      phase: 'result',
      ...(wp_path ? { wp_path } : {}),
      job_id: jobId,
      task_id: taskId,
      ...(run ? { run_id: run.id, stop_reason: run.stop_reason ?? '' } : {}),
      goal: graph.project.goal,
      state: run?.state ?? graph.project.status,
      summary,
      confirmed,
      candidates,
      errors,
    }
  }
  private deliver(agent: Agent, result: TaskResult) {
    result.session_id = String(agent.id)
    appendPluginRecord(agent.session, RESULT_RECORD, result)
    const text = UNTRUSTED_NOTICE + '\n' + JSON.stringify(result)
    // Frequent stage cards are visible events; only acceptance, direction and final results enter model context.
    if (result.phase === 'progress') return
    agent.inject(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'sapper-dsh',
          form: 'result',
          sections: [{ name: 'Sapper task result', text }],
        },
      }),
    )
  }
  @Remote({
    resources: { session: (sessionId: string) => SessionId(sessionId) },
  })
  async report(sessionId: string) {
    const agent = this.agent(sessionId),
      result = await this.result(agent, 'report-' + randomUUID())
    this.deliver(agent, result)
    return result
  }
  async whenIdle(cwd: string) {
    const base = resolveStorePath(cwd, this.getConfig())
    if (!base) return
    for (;;) {
      const job = this.jobs.get(base)
      await job?.done
      if (this.jobs.get(base) === job) return
    }
  }
}
export function registerTaskPanel(
  ctx: Context,
  getConfig: () => Config,
  alive: () => boolean,
) {
  const service = new TaskPanelService(ctx, getConfig, alive)
  ctx.inject(['typert'], (child) => {
    child.effect(() =>
      child.typert.register({
        package: 'sapper-dsh',
        face: 'host',
        model: { services: [], events: [], objects: [] },
        schemas: [],
        invocations: PANEL_REMOTE.descriptors,
      }),
    )
  })
  return service
}
