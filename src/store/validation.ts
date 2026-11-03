import type { Fact, Hint, Intent, Project } from './types.js'

export class StoreError extends Error {
  constructor(message: string) { super(message); this.name = 'SapperStoreError' }
}
export const FACT_KINDS = ['host', 'service', 'cred', 'vuln', 'loot', 'flag', 'note'] as const
export const FLAG_STATUSES = ['recorded', 'submitted', 'rejected', 'duplicate'] as const
export const ID = /^[a-z][a-z0-9_-]{0,16}$/
export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError(`${name}: 必须是 JSON 对象`)
  return value as Record<string, unknown>
}
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new StoreError(`${name}: 不能为空`)
  return value.trim()
}
export function id(value: unknown, kind: 'fact' | 'intent' | 'hint' | 'node' = 'node'): string {
  if (typeof value !== 'string' || !ID.test(value) || (value === 'goal' && !['fact', 'node'].includes(kind))) {
    throw new StoreError(`无效的 ${kind} id；不能包含路径`)
  }
  return value
}
export function nullable(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new StoreError(`${name}: 必须是字符串或 null`)
  return value.trim() || null
}
export function factData(value: unknown): Record<string, string> | null {
  if (value == null) return null
  const entries = Object.entries(object(value, 'data')).flatMap(([key, val]) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new StoreError(`data.${key}: 无效字段名`)
    if (val === null) return []
    if (!['string', 'number', 'boolean'].includes(typeof val) || (typeof val === 'number' && !Number.isFinite(val))) {
      throw new StoreError(`data.${key}: 只接受字符串、有限数字或布尔值`)
    }
    return [[key, String(val)]]
  })
  return entries.length ? Object.fromEntries(entries) : null
}
export function validateProject(value: unknown): Project {
  const data = structuredClone(object(value, 'project.json'))
  for (const key of ['id', 'origin', 'goal', 'status', 'created_at']) {
    if (typeof data[key] !== 'string') throw new StoreError(`project.json: ${key} 必须是字符串；M0 最小 fixture 不能作为完整图，请另建目录执行 sapper_init`)
  }
  text(data.goal, 'project.goal')
  if (!['active', 'completed'].includes(data.status as string)) throw new StoreError('project.status 无效')
  const counters = object(data.counters ?? {}, 'project.counters')
  for (const kind of ['fact', 'intent', 'hint', 'run']) {
    const n = counters[kind] ?? 0
    if (!Number.isSafeInteger(n) || (n as number) < 0) throw new StoreError(`project.counters.${kind} 必须是非负安全整数`)
    counters[kind] = n
  }
  data.counters = counters
  return data as unknown as Project
}
export function validateNode(value: unknown, kind: 'fact' | 'intent' | 'hint', filename?: string): Fact | Intent | Hint {
  const data = object(value, kind)
  const nodeId = id(data.id, kind)
  if (filename && filename !== `${nodeId}.json`) throw new StoreError(`${kind}: 文件名与 id 不一致`)
  const stringKeys = kind === 'hint' ? ['content', 'creator', 'created_at'] : ['description', 'created_at', 'creator']
  for (const key of stringKeys) if (typeof data[key] !== 'string') throw new StoreError(`${kind}.${nodeId}: ${key} 必须是字符串`)
  for (const key of ['title', 'doc']) if (data[key] != null && typeof data[key] !== 'string') throw new StoreError(`${nodeId}.${key}: 必须是字符串或 null`)
  if (kind === 'fact') {
    if (!('source_intent' in data)) throw new StoreError(`${nodeId}: 缺少 source_intent`)
    if (data.source_intent !== null) id(data.source_intent, 'intent')
    if (data.kind != null && !FACT_KINDS.includes(data.kind as never)) throw new StoreError(`${nodeId}: kind 无效`)
    factData(data.data)
  }
  if (kind === 'intent') {
    if (!Array.isArray(data.from) || !data.from.length) throw new StoreError(`${nodeId}: from 不能为空`)
    data.from.forEach(value => { id(value, 'fact'); if (value === 'goal') throw new StoreError('goal 不能作为依赖') })
    if (!('to' in data) || (data.to !== null && typeof data.to !== 'string')) throw new StoreError(`${nodeId}: to 必须是字符串或 null`)
    if (data.to !== null) id(data.to, 'fact')
    if (!['open', 'claimed', 'done', 'complete'].includes(data.status as string)) throw new StoreError(`${nodeId}: status 无效`)
    for (const key of ['worker', 'confirmed_at']) {
      if (!(key in data) || (data[key] !== null && typeof data[key] !== 'string')) throw new StoreError(`${nodeId}: ${key} 无效`)
    }
    if (typeof data.requires_confirmation !== 'boolean') throw new StoreError(`${nodeId}: requires_confirmation 无效`)
    const done = data.status === 'done' || data.status === 'complete'
    if (done !== (data.to !== null) || (data.status === 'complete' && data.to !== 'goal') || (data.status === 'done' && data.to === 'goal')) {
      throw new StoreError(`${nodeId}: status 与 to 不一致`)
    }
  }
  return data as unknown as Fact | Intent | Hint
}
