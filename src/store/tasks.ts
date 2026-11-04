import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import type { Config } from '../settings.js'
import { resolveStorePath } from './paths.js'
import { atomicJson, exists, readJson, safePath, serial } from './io.js'
import { GraphStore, type WriteOptions } from './graph.js'
import { object, StoreError, text } from './validation.js'

export interface TaskEntry { id: string; goal: string; created_at: string }
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
  const tasks = v.tasks.map(item => { const t = object(item, 'task'); return { id: taskId(t.id), goal: text(t.goal, 'goal'), created_at: text(t.created_at, 'created_at') } })
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
export async function createTask(base: string, cwd: string, goal: string, actor: string, options: WriteOptions): Promise<GraphStore> {
  goal = text(goal, 'goal')
  if (goal.length > 8000) throw new StoreError('任务目标最多 8000 字符')
  return catalogWrite(base, cwd, options, async () => {
    const catalog = await taskCatalog(base, cwd) ?? { version: 1 as const, active: 'legacy', tasks: [] }
    const task = { id: 't-' + randomUUID(), goal, created_at: new Date().toISOString() }
    const store = new GraphStore(taskRoot(base, task.id), cwd)
    await store.init('DSH task panel', goal, options)
    await store.addFact({ title: '任务上下文', kind: 'note', description: `用户任务：${goal}\n当前工作目录：${cwd}`, doc: '此记录只表示用户目标和会话工作目录；目标中的断言尚未观察或验证。使用外部工具实际检查目标。' }, actor, options)
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
