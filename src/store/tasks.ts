import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import type { Config } from '../settings.js'
import { resolveStorePath } from './paths.js'
import { atomicJson, exists, readJson, safePath, serial } from './io.js'
import { GraphStore, type WriteOptions } from './graph.js'
import { object, StoreError, text } from './validation.js'
import { projectFlagPolicy } from '../orchestration/flag-policy.js'

export type TaskPurpose = 'solve' | 'writeup'
export interface TaskEntry { id: string; goal: string; created_at: string; parent_task?: string; purpose?: TaskPurpose }
interface Catalog { version: 1; active: string; tasks: TaskEntry[] }
function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^t-[a-f0-9-]{36}$/.test(value)) throw new StoreError('无效任务 ID')
  return value
}
export async function taskCatalog(base: string, cwd: string): Promise<Catalog | undefined> {
  const file = path.join(base, 'tasks', 'index.json')
  await safePath(file, cwd)
  if (!await exists(file)) return undefined
  const v = object(await readJson(file), 'task catalog')
  if (v.version !== 1 || !Array.isArray(v.tasks)) throw new StoreError('任务目录损坏')
  const tasks = v.tasks.map((item): TaskEntry => { const t = object(item, 'task'); return { id: taskId(t.id), goal: text(t.goal, 'goal'), created_at: text(t.created_at, 'created_at'), ...(typeof t.parent_task === 'string' ? { parent_task: t.parent_task === 'legacy' ? 'legacy' : taskId(t.parent_task) } : {}), ...(t.purpose === 'solve' || t.purpose === 'writeup' ? { purpose: t.purpose } : {}) } })
  const active = v.active === 'legacy' ? 'legacy' : taskId(v.active)
  if (active !== 'legacy' && !tasks.some(t => t.id === active)) throw new StoreError('当前任务不存在')
  return { version: 1, active, tasks }
}
export function taskRoot(base: string, id: string): string { return id === 'legacy' ? base : path.join(base, 'tasks', taskId(id)) }
export async function resolveSelectedStore(cwd: string | undefined, config: Config): Promise<string | undefined> {
  const base = resolveStorePath(cwd, config)
  if (!base || !cwd) return undefined
  const catalog = await taskCatalog(base, cwd)
  return catalog ? taskRoot(base, catalog.active) : base
}
async function catalogWrite<T>(base: string, cwd: string, options: WriteOptions, action: () => Promise<T>): Promise<T> {
  return serial(base + '/tasks', async () => {
    options.signal?.throwIfAborted(); options.guard?.()
    const dir = path.join(base, 'tasks'), lock = path.join(dir, 'CATALOG_LOCK')
    await safePath(lock, cwd); await mkdir(dir, { recursive: true })
    try { await mkdir(lock) } catch { throw new StoreError('任务目录正在被其他进程修改，请稍后重试') }
    try { return await action() } finally { await rmdir(lock) }
  })
}
export async function createTask(base: string, cwd: string, goal: string, actor: string, options: WriteOptions, followup?: { task_id: string; purpose: TaskPurpose }): Promise<GraphStore> {
  goal = text(goal, 'goal')
  if (goal.length > 8000) throw new StoreError('任务目标最多 8000 字符')
  return catalogWrite(base, cwd, options, async () => {
    const catalog = await taskCatalog(base, cwd) ?? { version: 1 as const, active: 'legacy', tasks: [] }
    if (followup && followup.task_id !== 'legacy' && !catalog.tasks.some(t => t.id === followup.task_id)) throw new StoreError('前序任务不存在')
    const source = followup ? new GraphStore(taskRoot(base, followup.task_id), cwd) : undefined
    const graph = await source?.read(), runs = await source?.listRuns()
    const task: TaskEntry = { id: 't-' + randomUUID(), goal, created_at: new Date().toISOString(), ...(followup ? { parent_task: followup.task_id, purpose: followup.purpose } : {}) }
    const store = new GraphStore(taskRoot(base, task.id), cwd)
    await store.init('DSH task panel', goal, options)
    await store.addFact({ title: '任务上下文', kind: 'note', description: `用户任务：${goal}\n当前工作目录：${cwd}`, doc: '此记录只表示用户目标和会话工作目录；目标中的断言尚未观察或验证。使用外部工具实际检查目标。' }, actor, options)
    if (followup && graph) {
      const history = JSON.stringify({ parent_task: followup.task_id, root: source!.root, goal: graph.project.goal,
        facts: graph.facts.filter(f => f.id !== 'goal').map(f => ({ id: f.id, title: f.title, description: f.description, kind: f.kind, verification_status: f.verification_status, data: f.data })),
        runs: runs?.slice(-3).map(r => ({ id: r.id, state: r.state, outcomes: r.outcomes, flag_observations: r.flag_observations, flag_progress: r.flag_progress })) })
      const brief = JSON.stringify({ goal: graph.project.goal, facts: graph.facts.filter(f => f.id !== 'goal').slice(-6).map(f => ({ id: f.id, description: f.description.slice(0, 300) })), candidates: runs?.flatMap(r => r.outcomes).filter(o => o.candidate).slice(-4).map(o => ({ description: o.candidate!.description.slice(0, 300), status: o.state })) })
      await store.configurePhase(followup.task_id, followup.purpose, followup.purpose === 'solve' ? goal : typeof graph.project.solve_goal === 'string' ? graph.project.solve_goal : graph.project.goal, options)
      const policy = projectFlagPolicy(graph.project)
      if (policy && followup.purpose === 'solve') await store.configureFlagPolicy(policy, options)
      if (typeof graph.project.verification_mode === 'string') await store.configureVerification(graph.project.verification_mode as import('../orchestration/verification-policy.js').VerificationMode, options)
      await store.addFact({ title: '前序任务与证据线索', kind: 'note', description: `前序目录：${source!.root}\n历史 flag 不代表本轮成功。纠错时必须重新取证；编写 WP 时引用保存的证据，默认不重新访问外部目标。\n${brief.slice(0, 1800)}`, doc: history.slice(0, 160000) }, actor, options)
    }
    options.signal?.throwIfAborted(); options.guard?.()
    await atomicJson(path.join(base, 'tasks', 'index.json'), { ...catalog, active: task.id, tasks: [...catalog.tasks, task] })
    return store
  })
}
export async function selectTask(base: string, cwd: string, selected: string, options: WriteOptions): Promise<GraphStore> {
  return catalogWrite(base, cwd, options, async () => {
    const catalog = await taskCatalog(base, cwd) ?? { version: 1 as const, active: 'legacy', tasks: [] }
    if (selected !== 'legacy' && !catalog.tasks.some(t => t.id === selected)) throw new StoreError('任务不存在')
    const store = new GraphStore(taskRoot(base, selected), cwd)
    await store.read()
    options.signal?.throwIfAborted(); options.guard?.()
    await atomicJson(path.join(base, 'tasks', 'index.json'), { ...catalog, active: selected })
    return store
  })
}
