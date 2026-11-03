import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { absent, readJson, safePath } from '../store/io.js'
import { StoreError, object } from '../store/validation.js'
import { limitResults, matchText, normalize } from '../recall/index.js'
import type { KnowledgeBrief } from '../render/snapshot.js'

export interface KnowledgeEntry extends KnowledgeBrief {
  detail: string | null; commands: string[]; source: string | null; created_at?: string
}
export interface KnowledgeSnapshot { entries: KnowledgeEntry[]; warnings: string[] }
const KB_ID = /^kb\d{3,}$/
const require = createRequire(import.meta.url)
const bundledRoot = () => path.join(path.dirname(require.resolve('sapper-dsh/package.json')), 'resources', 'kb')
let bundled: Promise<KnowledgeSnapshot> | undefined

function validate(value: unknown, filename: string): KnowledgeEntry {
  const data = object(value, 'KB')
  if (typeof data.id !== 'string' || !KB_ID.test(data.id) || filename !== `${data.id}.json`) throw new StoreError('KB id 与文件名不一致')
  if (typeof data.title !== 'string' || !data.title.trim() || typeof data.description !== 'string') throw new StoreError('KB 缺少 title/description')
  for (const key of ['detail', 'source']) if (data[key] != null && typeof data[key] !== 'string') throw new StoreError(`KB ${key} 无效`)
  if (!Array.isArray(data.tags) || !data.tags.every(v => typeof v === 'string')) throw new StoreError('KB tags 无效')
  if (!Array.isArray(data.commands) || !data.commands.every(v => typeof v === 'string')) throw new StoreError('KB commands 无效')
  return { id: data.id, title: data.title, description: data.description, tags: data.tags as string[],
    detail: data.detail as string | null ?? null, commands: data.commands as string[], source: data.source as string | null ?? null,
    ...(typeof data.created_at === 'string' ? { created_at: data.created_at } : {}) }
}
async function load(root: string, boundary: string, optional = false): Promise<KnowledgeSnapshot> {
  await safePath(root, boundary)
  let names: string[]
  try { names = await readdir(root) } catch (error) {
    if (absent(error) && optional) return { entries: [], warnings: ['自定义 KB 目录不存在，使用内置 KB'] }
    throw error
  }
  const entries: KnowledgeEntry[] = [], warnings: string[] = []
  for (const filename of names.sort().filter(n => n.endsWith('.json'))) {
    try {
      const file = path.join(root, filename)
      await safePath(file, boundary)
      entries.push(validate(await readJson(file), filename))
    } catch (error) { warnings.push(`${filename}: ${(error as Error).message}`) }
  }
  return { entries, warnings }
}
export class KnowledgeBase {
  async read(cwd?: string, customDir = ''): Promise<KnowledgeSnapshot> {
    bundled ??= load(bundledRoot(), path.dirname(bundledRoot()))
    const base = await bundled
    if (!customDir.trim()) return structuredClone(base)
    if (!cwd || !path.isAbsolute(cwd)) throw new StoreError('自定义 KB 需要绝对工作区路径')
    const root = path.resolve(cwd, customDir)
    if (root === path.resolve(cwd)) throw new StoreError('自定义 KB 必须在工作区的独立子目录')
    const extra = await load(root, path.resolve(cwd), true)
    const byId = new Map(base.entries.map(entry => [entry.id, entry]))
    for (const entry of extra.entries) byId.set(entry.id, entry)
    return structuredClone({ entries: [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), warnings: [...base.warnings, ...extra.warnings] })
  }
  get(snapshot: KnowledgeSnapshot, nodeId: string): KnowledgeEntry {
    if (!KB_ID.test(nodeId)) throw new StoreError('KB id 必须形如 kb001，不接受路径')
    const entry = snapshot.entries.find(e => e.id === nodeId)
    if (!entry) throw new StoreError(`KB ${nodeId} 不存在`)
    return entry
  }
  search(snapshot: KnowledgeSnapshot, query: string, limit = 5, tag?: string) {
    limitResults(limit)
    return snapshot.entries.filter(e => !tag || e.tags.some(t => normalize(t) === normalize(tag))).map(entry => ({
      ...kbBrief(entry), ...matchText(query, entry.title, `${entry.description} ${entry.tags.join(' ')} ${(entry.detail ?? '').slice(0, 500)}`),
    })).filter(e => e.score > 0).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit)
  }
}
export const kbBrief = (entry: KnowledgeEntry) => ({ id: entry.id, title: entry.title, description: entry.description,
  tags: entry.tags, has_detail: !!entry.detail, n_commands: entry.commands.length })
