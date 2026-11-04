import path from 'node:path'
import {
  mkdir,
  lstat,
  realpath,
  readFile,
  readdir,
  writeFile,
  open,
} from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { TaskPanelService } from '../dsh-adapter/panel.js'
import { runId as validateRunId } from '../store/runs.js'
import { GraphStore } from '../store/graph.js'
import { taskCatalog, taskRoot } from '../store/tasks.js'
import { safePath } from '../store/io.js'
import { StoreError } from '../store/validation.js'
import {
  launchSchema,
  preferencesSchema,
  type LaunchInput,
  type LaunchRecord,
  type Preferences,
  type TaskAddress,
  type TaskDetail,
  type WorkbenchSnapshot,
  type Challenge,
  type Phase,
} from './contracts.js'
import type { PanelAction } from '../panel/rpc.js'

export function directoryName(
  title: string,
  requestId: string,
  date = new Date(),
) {
  let slug = title
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
  slug = Array.from(slug)
    .slice(0, 48)
    .join('')
    .replace(/[. ]+$/g, '')
  if (!slug || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(slug))
    slug = 'challenge'
  return `${slug}-${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${requestId.slice(0, 8)}`
}
export class NativeWorkbench {
  private inflight = new Map<
    string,
    { input: LaunchInput; promise: Promise<LaunchRecord> }
  >()
  private overviewCache:
    | { until: number; promise: Promise<WorkbenchSnapshot> }
    | undefined
  constructor(
    private ctx: Context,
    private panel: TaskPanelService,
    private getRoot: (cwd: string) => string,
  ) {}
  private get store() {
    return this.panel.workbench
  }
  private workspace(id: string) {
    const known = this.ctx.get('workspaceRegistry')?.get(id as WorkspaceId)
    if (known)
      return {
        id,
        cwd: known.path,
        title: known.title,
        sessions: known.sessionIds.map(String),
      }
    if (id.startsWith('session:')) {
      const agent = this.ctx.agents.get(SessionId(id.slice(8)))
      if (
        agent &&
        this.ctx.agents.roots().includes(agent) &&
        agent.session.header.cwd
      )
        return {
          id,
          cwd: agent.session.header.cwd,
          title: path.basename(agent.session.header.cwd),
          sessions: [String(agent.id)],
        }
    }
    throw new StoreError('工作区不存在，请从 Sapper 列表重新选择')
  }
  async preferences(input: Preferences) {
    const value = preferencesSchema.parse(input)
    if (value.rootDir) {
      if (!path.isAbsolute(value.rootDir))
        throw new StoreError('比赛根目录需要绝对路径')
      value.rootDir = await realpath(value.rootDir)
      if (!(await lstat(value.rootDir)).isDirectory())
        throw new StoreError('比赛根目录不是文件夹')
    }
    await this.store.change((d) => {
      d.preferences = value
    })
    this.overviewCache = undefined
    void this.panel.pump()
    return value
  }
  launch(input: LaunchInput) {
    input = launchSchema.parse(input)
    const pending = this.inflight.get(input.requestId)
    if (pending) {
      if (JSON.stringify(pending.input) !== JSON.stringify(input))
        return Promise.reject(new StoreError('同一启动请求不能更换目标或目录'))
      return pending.promise
    }
    const promise = this.provision(input).finally(() =>
      this.inflight.delete(input.requestId),
    )
    this.inflight.set(input.requestId, { input, promise })
    return promise
  }
  private async provision(input: LaunchInput): Promise<LaunchRecord> {
    await this.store.ready
    if (!this.store.durable)
      throw new StoreError('正在等待 DSH 工作台持久化服务，请稍后重试')
    const registry = this.ctx.get('workspaceRegistry'),
      sessions = this.ctx.get('sessionController')
    if (!registry || !sessions)
      throw new StoreError('DSH 原生工作区/会话服务尚未就绪')
    if (!path.isAbsolute(input.rootDir))
      throw new StoreError('比赛根目录需要绝对路径')
    const root = await realpath(input.rootDir)
    if (!(await lstat(root)).isDirectory())
      throw new StoreError('比赛根目录不是文件夹')
    const existing = this.store.snapshot().launches[input.requestId]
    if (existing && JSON.stringify(existing.input) !== JSON.stringify(input))
      throw new StoreError('同一启动请求不能更换目标或目录；请新建题目')
    let record: LaunchRecord = existing ?? {
      requestId: input.requestId,
      input,
      title: input.title.trim() || input.goal.trim().slice(0, 60),
      cwd: path.join(
        root,
        directoryName(input.title || '题目', input.requestId),
      ),
      createdAt: new Date().toISOString(),
    }
    const save = async () => {
      await this.store.change((d) => {
        d.launches[input.requestId] = { ...record }
      })
      this.overviewCache = undefined
    }
    await save()
    try {
      await safePath(record.cwd, root)
      try {
        await mkdir(record.cwd)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (
        (await lstat(record.cwd)).isSymbolicLink() ||
        !(await lstat(record.cwd)).isDirectory()
      )
        throw new StoreError('题目目录被替换，请重新选择目录')
      const marker = path.join(record.cwd, '.sapper-launch.json')
      await safePath(marker, root)
      try {
        await writeFile(
          marker,
          JSON.stringify({ requestId: record.requestId }),
          { flag: 'wx' },
        )
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          JSON.parse(await readFile(marker, 'utf8')).requestId !==
            record.requestId
        )
          throw new StoreError('题目目录已有其他内容标识，未覆盖任何文件')
      }
      if (!record.workspaceId) {
        record.workspaceId = String(
          (await registry.create(record.cwd, record.title)).id,
        )
        await save()
      }
      if (
        this.workspace(record.workspaceId).cwd !== (await realpath(record.cwd))
      )
        throw new StoreError('工作区与题目目录不一致')
      if (!record.sessionId) {
        const created = await sessions.create({
          workspaceId: record.workspaceId as WorkspaceId,
          sessionId: SessionId('sapper-' + input.requestId),
          ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
        })
        record.sessionId = String(created.sessionId)
        await save()
      }
      const agent = await this.panel.resolveAgent(record.sessionId)
      if (
        (await realpath(agent.session.header.cwd!)) !==
        (await realpath(record.cwd))
      )
        throw new StoreError('主会话目录不匹配')
      if (!record.jobId) {
        if (input.model)
          await sessions.selectModel({
            sessionId: agent.id,
            provider: input.model.provider,
            model: input.model.model,
            ...(input.model.reasoningEffort
              ? { reasoningEffort: input.model.reasoningEffort }
              : {}),
          })
        if (input.permissionPreset) {
          const permissions = this.ctx.get('permissionPresets')
          if (!permissions) throw new StoreError('DSH 权限配置服务不可用')
          permissions.set(agent.session, input.permissionPreset)
        }
        await sessions.rename({ sessionId: agent.id, title: record.title })
        record.jobId = await this.panel.startNative(
          agent,
          input.goal,
          input.requestId,
        )
      }
      delete record.error
      await save()
      return record
    } catch (error) {
      record = { ...record, error: (error as Error).message }
      await save()
      throw error
    }
  }
  overview(): Promise<WorkbenchSnapshot> {
    if (this.overviewCache && this.overviewCache.until > Date.now())
      return this.overviewCache.promise
    const promise = this.collect()
    this.overviewCache = { until: Date.now() + 800, promise }
    return promise
  }
  private async collect(): Promise<WorkbenchSnapshot> {
    await this.store.flush()
    const data = this.store.snapshot(),
      challenges: Challenge[] = []
    const known =
      this.ctx
        .get('workspaceRegistry')
        ?.list()
        .map((w) => ({
          id: String(w.id),
          cwd: w.path,
          title: w.title,
          sessions: w.sessionIds.map(String),
        })) ?? []
    for (const agent of this.ctx.agents.roots())
      if (
        agent.session.header.cwd &&
        !known.some((w) => w.cwd === agent.session.header.cwd)
      )
        known.push({
          id: 'session:' + String(agent.id),
          cwd: agent.session.header.cwd,
          title: path.basename(agent.session.header.cwd),
          sessions: [String(agent.id)],
        })
    for (const workspace of known) {
      const base = this.getRoot(workspace.cwd)
      const jobs = Object.values(data.jobs)
        .filter((j) => j.cwd === workspace.cwd)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const sessionId = jobs.at(-1)?.sessionId ?? workspace.sessions[0] ?? ''
      try {
        const catalog = await taskCatalog(base, workspace.cwd),
          entries = [...(catalog?.tasks ?? [])]
        const legacy = new GraphStore(base, workspace.cwd)
        try {
          if (await legacy.initialized()) {
            const graph = await legacy.read()
            entries.unshift({
              id: 'legacy',
              goal: graph.project.goal,
              created_at: graph.project.created_at,
            })
          }
        } catch (error) {
          challenges.push({
            id: workspace.id + ':legacy-error',
            workspaceId: workspace.id,
            taskId: 'legacy',
            sessionId,
            cwd: workspace.cwd,
            title: '原工作区图无法读取',
            goal: '新任务仍可正常使用',
            state: 'failed',
            updatedAt: '',
            createdAt: '',
            unread: false,
            phases: [],
            flags: [],
            error: (error as Error).message,
          })
        }
        const groups = new Map<string, typeof entries>()
        for (const task of entries) {
          let root = task,
            seen = new Set<string>()
          while (root.parent_task && !seen.has(root.id)) {
            seen.add(root.id)
            const previous = entries.find((t) => t.id === root.parent_task)
            if (!previous) break
            root = previous
          }
          const group = groups.get(root.id) ?? []
          group.push(task)
          groups.set(root.id, group)
        }
        for (const [rootId, tasks] of groups) {
          const root = entries.find((t) => t.id === rootId)!,
            flags = new Map<string, 'candidate' | 'confirmed' | 'rejected'>(),
            phases: Phase[] = []
          let updatedAt = root.created_at,
            status = 'idle'
          for (const task of tasks) {
            const store = new GraphStore(
                taskRoot(base, task.id),
                workspace.cwd,
              ),
              graph = await store.read(),
              runs = await store.listRuns()
            phases.push({
              taskId: task.id,
              goal: task.goal,
              purpose: task.purpose ?? 'solve',
              status: graph.project.status,
              runs: runs.map((r) => ({
                id: r.id,
                state: r.state,
                ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
                updatedAt: r.updated_at,
              })),
            })
            for (const run of runs) {
              if (run.updated_at > updatedAt) updatedAt = run.updated_at
              for (const o of run.outcomes)
                if (
                  o.candidate?.kind === 'flag' &&
                  flags.get(o.candidate.description) !== 'confirmed'
                )
                  flags.set(
                    o.candidate.description,
                    o.verification?.verified === false
                      ? 'rejected'
                      : o.state === 'confirmed'
                        ? 'confirmed'
                        : 'candidate',
                  )
            }
            for (const fact of graph.facts)
              if (fact.kind === 'flag')
                flags.set(
                  fact.data?.value ?? fact.description,
                  fact.data?.status === 'rejected'
                    ? 'rejected'
                    : fact.verification_status === 'confirmed'
                      ? 'confirmed'
                      : 'candidate',
                )
            if (graph.project.status === 'completed') status = 'completed'
          }
          if ([...flags.values()].includes('candidate')) status = 'candidate'
          if ([...flags.values()].includes('confirmed')) status = 'confirmed'
          const ids = new Set(tasks.map((t) => t.id)),
            job = jobs
              .filter((j) =>
                j.taskId
                  ? ids.has(j.taskId)
                  : j.input.task_id
                    ? ids.has(j.input.task_id)
                    : false,
              )
              .at(-1)
          if (
            job &&
            [
              'queued',
              'running',
              'cancelling',
              'interrupted',
              'failed',
            ].includes(job.state)
          )
            status = job.state
          const launch=Object.values(data.launches).find(l=>l.cwd===workspace.cwd&&jobs.some(j=>j.id===l.jobId&&j.taskId===rootId))
          const id = workspace.id + ':' + rootId
          challenges.push({
            id,
            workspaceId: workspace.id,
            taskId: rootId,
            sessionId: job?.sessionId ?? sessionId,
            cwd: workspace.cwd,
            title:
              launch?.title ?? (tasks.length === entries.length ? workspace.title : root.goal.slice(0,60)),
            goal: root.goal,
            state: status,
            createdAt: root.created_at,
            updatedAt,
            unread: (data.seen[id] ?? '') < updatedAt,
            phases,
            flags: [...flags].map(([value, state]) => ({
              value,
              status: state,
            })),
            ...(job ? { job } : {}),
          })
        }
        const preparing = jobs.filter(
          (j) =>
            !j.taskId &&
            (j.input.action === 'start' || !entries.length) &&
            !entries.some(
              (t) => t.goal === j.goal && t.created_at >= j.createdAt,
            ),
        )
        for (const job of preparing)
          challenges.push({
            id: 'job:' + job.id,
            workspaceId: workspace.id,
            taskId: 'legacy',
            sessionId: job.sessionId,
            cwd: workspace.cwd,
            title: workspace.title,
            goal: job.goal,
            state: job.state,
            updatedAt: job.createdAt,
            createdAt: job.createdAt,
            unread: false,
            phases: [],
            flags: [],
            job,
          })
      } catch (error) {
        challenges.push({
          id: workspace.id + ':error',
          workspaceId: workspace.id,
          taskId: 'legacy',
          sessionId,
          cwd: workspace.cwd,
          title: workspace.title,
          goal: '',
          state: 'failed',
          updatedAt: '',
          createdAt: '',
          unread: false,
          phases: [],
          flags: [],
          error: (error as Error).message,
        })
      }
    }
    const model = this.ctx.get('agentDefaultModel')?.currentSelection(),
      permissions = this.ctx.get('permissionPresets'),
      presets = this.ctx.get('agentPresets')
    return {
      preferences: data.preferences,
      durable: this.store.durable,
      available: Boolean(
        this.ctx.get('workspaceRegistry') && this.ctx.get('sessionController'),
      ),
      launches: Object.values(data.launches),
      challenges: challenges.sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      jobs: Object.values(data.jobs),
      briefs: Object.values(data.briefs),
      defaults: {
        ...(model
          ? {
              model: {
                ...model,
                ...(model.reasoningEffort
                  ? { reasoningEffort: String(model.reasoningEffort) }
                  : {}),
              },
            }
          : {}),
        ...(permissions ? { permissionPreset: permissions.defaultPreset } : {}),
        ...(presets ? { agentPreset: presets.defaultId } : {}),
        permissions:
          permissions
            ?.catalog()
            .options.map((p) => ({ id: p.value, label: p.name })) ?? [],
        presets: (await presets?.list())?.map((p) => p.id) ?? [],
      },
    }
  }
  async detail(input: TaskAddress): Promise<TaskDetail> {
    const workspace = this.workspace(input.workspaceId),
      base = this.getRoot(workspace.cwd)
    const store = new GraphStore(taskRoot(base, input.taskId), workspace.cwd)
    const sessionId =
      Object.values(this.store.snapshot().jobs)
        .filter((j) => j.cwd === workspace.cwd)
        .at(-1)?.sessionId ??
      workspace.sessions[0] ??
      ''
    if (
      input.taskId !== 'legacy' &&
      !(await taskCatalog(base, workspace.cwd))?.tasks.some(
        (t) => t.id === input.taskId,
      )
    )
      throw new StoreError('题目阶段不存在')
    if (input.runId) await store.readRun(input.runId)
    const state = await this.panel.readState(
      workspace.cwd,
      sessionId,
      input.taskId,
      input.runId,
    )
    const runs = (await store.initialized())
      ? (await store.listRuns())
          .filter((r) => !input.runId || r.id === input.runId)
          .slice(-8)
          .reverse()
      : []
    const run = runs[0],
      evidence: TaskDetail['evidence'] = []
    if (run)
      for (const o of run.outcomes)
        for (const [role, result] of [
          ['explore', o.candidate],
          ['verify', o.verification],
        ] as const)
          if (result)
            for (const e of result.evidence)
              evidence.push({
                intentId: o.intent_id,
                role,
                sessionId:
                  role === 'explore'
                    ? o.candidate!.explorer_session
                    : o.verification!.verifier_session,
                tool: e.tool,
                excerpt: e.excerpt,
                ...(e.sha256 ? { sha256: e.sha256 } : {}),
              })
    const graph = (await store.initialized()) ? await store.read() : undefined
    const totalNodes = graph ? graph.facts.length - 1 + graph.intents.length : 0
    if (graph && run && state.graph?.nodes)
      for (const node of state.graph.nodes)
        if (
          run.outcomes.find((o) => o.intent_id === node.id)?.state === 'stopped'
        )
          node.status = 'stopped'
    let result: TaskDetail['result']
    if (graph)
      result = await this.panel.resultAt(
        workspace.cwd,
        'view',
        input.taskId,
        run?.id,
      )
    return {
      address: input,
      state,
      ...(result ? { result } : {}),
      evidence,
      files: (
        await this.files(workspace.cwd, {
          ...input,
          ...(run ? { runId: run.id } : {}),
        })
      ).map(({ name, size, snapshot }) => ({
        name,
        size,
        ...(snapshot ? { snapshot } : {}),
      })),
      totalNodes,
      hiddenNodes: Math.max(0, totalNodes - (state.graph?.nodes?.length ?? 0)),
    }
  }
  private async files(cwd: string, input: TaskAddress) {
    const names = ['WP.md']
    try {
      names.push(
        ...(await readdir(path.join(cwd, 'evidence')))
          .slice(0, 60)
          .map((n) => 'evidence/' + n),
      )
    } catch {}
    const result: Array<{
      name: string
      size: number
      file: string
      snapshot?: boolean
    }> = []
    const base = this.getRoot(cwd),
      store = new GraphStore(taskRoot(base, input.taskId), cwd)
    if (
      input.taskId !== 'legacy' &&
      !(await taskCatalog(base, cwd))?.tasks.some((t) => t.id === input.taskId)
    )
      throw new StoreError('题目阶段不存在')
    const id = input.runId
      ? validateRunId(input.runId)
      : (await store.listRuns()).at(-1)?.id
    if (input.runId) await store.readRun(id!)
    const archived = id
      ? path.join(store.root, 'artifacts', id, 'WP.md')
      : undefined
    for (const name of names)
      try {
        let file = path.join(cwd, name),
          snapshot = false
        if (name === 'WP.md' && archived) {
          await safePath(archived, cwd)
          try {
            if ((await lstat(archived)).isFile()) {
              file = archived
              snapshot = true
            }
          } catch {}
        }
        await safePath(file, cwd)
        const stat = await lstat(file)
        if (stat.isFile() && !stat.isSymbolicLink())
          result.push({ name, size: stat.size, file, snapshot })
      } catch {}
    return result
  }
  async file(input: TaskAddress, name: string) {
    const { cwd } = this.workspace(input.workspaceId)
    const selected = (await this.files(cwd, input)).find((f) => f.name === name)
    if (!selected || !/\.(md|txt|json|log|csv|html?)$/i.test(name))
      throw new StoreError('该文件不在当前题目的可预览文件列表中')
    const file = selected.file
    await safePath(file, cwd)
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(256000)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      return {
        text: text.slice(0, 64000),
        truncated:
          (await handle.stat()).size > bytesRead || text.length > 64000,
      }
    } finally {
      await handle.close()
    }
  }
  async taskAction(input: TaskAddress, action: PanelAction) {
    const workspace = this.workspace(input.workspaceId)
    const base = this.getRoot(workspace.cwd)
    const catalog = await taskCatalog(base, workspace.cwd)
    if (
      input.taskId !== 'legacy' &&
      !catalog?.tasks.some((t) => t.id === input.taskId)
    )
      throw new StoreError('题目阶段不存在')
    if (input.runId)
      await new GraphStore(taskRoot(base, input.taskId), workspace.cwd).readRun(
        input.runId,
      )
    if (input.runId && action.run_id && input.runId !== action.run_id)
      throw new StoreError('执行记录地址不一致')
    const records = Object.values(this.store.snapshot().jobs).filter(
      (j) => j.cwd === workspace.cwd,
    )
    const current = records
      .filter((j) => ['queued', 'running', 'cancelling'].includes(j.state))
      .at(-1)
    if (
      current &&
      ['cancel', 'steer'].includes(action.action) &&
      (current.taskId ?? current.input.task_id ?? 'legacy') !== input.taskId
    )
      throw new StoreError('当前运行属于其他阶段，请选择正在执行的阶段')
    const record = records
      .filter(
        (j) =>
          j.taskId === input.taskId ||
          j.input.task_id === input.taskId ||
          (!j.taskId && input.taskId === 'legacy'),
      )
      .at(-1)
    const agent = await this.panel.resolveAgent(
      record?.sessionId ?? workspace.sessions[0] ?? '',
    )
    this.overviewCache = undefined
    return this.panel.submit(agent, {
      ...action,
      action: action.action === 'run' ? 'resume' : action.action,
      task_id: input.taskId,
      ...(input.runId ? { run_id: input.runId } : {}),
    })
  }
  async node(input: TaskAddress, id: string) {
    const { cwd } = this.workspace(input.workspaceId),
      base = this.getRoot(cwd)
    if (
      input.taskId !== 'legacy' &&
      !(await taskCatalog(base, cwd))?.tasks.some((t) => t.id === input.taskId)
    )
      throw new StoreError('题目阶段不存在')
    if (!/^[fi]\d+$/.test(id)) throw new StoreError('无效节点 ID')
    const store = new GraphStore(taskRoot(base, input.taskId), cwd)
    return id[0] === 'f'
      ? store.readNode('fact', id)
      : store.readNode('intent', id)
  }
  async seen(id: string) {
    await this.store.change((d) => {
      d.seen[id] = new Date().toISOString()
    })
    this.overviewCache = undefined
  }
}
