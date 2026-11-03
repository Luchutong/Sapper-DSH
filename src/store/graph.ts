import { mkdir, readdir, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { absent, atomicJson, exists, readJson, safePath, serial } from './io.js'
import { FACT_KINDS, FLAG_STATUSES, StoreError, factData, id, nullable, object, text, validateNode, validateProject } from './validation.js'
import type { Fact, FactKind, GraphSnapshot, Hint, Intent, Project } from './types.js'

type Entry = { file: string; value: unknown }
type Changes = Map<string, unknown>
export interface WriteOptions { signal?: AbortSignal; guard?: () => void; autoConfirm?: () => boolean }
export interface FactInput {
  description: string
  title?: string | null | undefined
  doc?: string | null | undefined
  kind?: string | null | undefined
  data?: unknown
  source_intent?: string | null | undefined
}
export interface IntentInput {
  from: string[]
  description: string
  title?: string | null | undefined
  doc?: string | null | undefined
  requires_confirmation?: boolean | undefined
}
export type FlagStatus = typeof FLAG_STATUSES[number]
export interface FlagEntry {
  id: string; value: string; status: FlagStatus; source_fact: string | null
  challenge: string; captured_at: string; note: string
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const journalName = '.transaction.json'
const lockName = 'LOCK'
const nodeDir = { fact: 'facts', intent: 'intents', hint: 'hints' } as const

/** Python-compatible graph files; one queue per root and an exclusive mkdir lock for TS writers. */
export class GraphStore {
  readonly root: string
  readonly boundary: string
  constructor(root: string, boundary = path.dirname(root)) {
    this.root = path.resolve(root)
    this.boundary = path.resolve(boundary)
    if (this.root === this.boundary) throw new StoreError('存储必须位于工作区的独立子目录')
  }
  private file(relative: string) { return path.join(this.root, relative) }
  private async checked(relative: string) {
    const file = this.file(relative)
    await safePath(file, this.boundary)
    return file
  }
  async initialized(): Promise<boolean> {
    return exists(await this.checked('project.json'))
  }
  private async getProject(): Promise<Project> {
    const file = await this.checked('project.json')
    if (!await exists(file)) throw new StoreError('尚未初始化事实图；请先调用 sapper_init，或选择已有 .sapper 的工作区')
    return validateProject(await readJson(file))
  }
  private async getNode(kind: 'fact' | 'intent' | 'hint', nodeId: string): Promise<Fact | Intent | Hint> {
    id(nodeId, kind)
    const filename = `${nodeId}.json`
    const file = await this.checked(`${nodeDir[kind]}/${filename}`)
    if (!await exists(file)) throw new StoreError(`${kind} ${nodeId} 不存在`)
    return validateNode(await readJson(file), kind, filename)
  }
  private async listNodes<T extends Fact | Intent | Hint>(kind: 'fact' | 'intent' | 'hint', warnings: string[]): Promise<T[]> {
    const dir = await this.checked(nodeDir[kind])
    let names: string[]
    try { names = await readdir(dir) } catch (error) { if (absent(error)) return []; throw error }
    const nodes: T[] = []
    for (const name of names.sort().filter(name => name.endsWith('.json'))) {
      try {
        const file = await this.checked(`${nodeDir[kind]}/${name}`)
        nodes.push(validateNode(await readJson(file), kind, name) as T)
      } catch (error) { warnings.push(`${kind}/${name}: ${(error as Error).message}`) }
    }
    return nodes
  }
  private async snapshot(): Promise<GraphSnapshot> {
    const warnings: string[] = []
    const project = await this.getProject()
    const facts = await this.listNodes<Fact>('fact', warnings)
    const intents = await this.listNodes<Intent>('intent', warnings)
    const hints = await this.listNodes<Hint>('hint', warnings)
    const integrity: string[] = []
    try { this.flagEntries(facts) } catch (error) { integrity.push((error as Error).message) }
    const byFact = new Map(facts.map(f => [f.id, f]))
    const byIntent = new Map(intents.map(i => [i.id, i]))
    if (byFact.get('goal')?.description !== project.goal) integrity.push('goal 事实缺失或与项目目标不一致')
    for (const intent of intents) {
      for (const dependency of intent.from) if (!byFact.has(dependency)) integrity.push(`${intent.id}: 依赖 ${dependency} 不存在`)
      if (intent.to && intent.to !== 'goal' && byFact.get(intent.to)?.source_intent !== intent.id) integrity.push(`${intent.id}: 结果事实与反向引用不一致`)
    }
    for (const fact of facts) if (fact.source_intent && byIntent.get(fact.source_intent)?.to !== fact.id) integrity.push(`${fact.id}: 来源意图与结果引用不一致`)
    const completions = intents.filter(i => i.to === 'goal')
    if (completions.length > 1 || (project.status === 'completed') !== (completions.length > 0)) integrity.push('项目状态与终态意图不一致')
    return { project, facts, intents, hints, warnings, integrity }
  }
  private async idle(): Promise<void> {
    if (await exists(await this.checked(lockName))) throw new StoreError('事实图正被其他写者使用（LOCK）；请稍后重试')
    if (await exists(await this.checked(journalName))) throw new StoreError('发现未完成事务；请按会话写权限调用 sapper_init(action=recover)，再重试读取')
  }
  async checkReadable(): Promise<void> { await this.idle() }
  async read(): Promise<GraphSnapshot> {
    return serial(this.root, async () => {
      await this.idle()
      const graph = await this.snapshot()
      await this.idle()
      return graph
    })
  }
  async readNode(kind: 'fact', nodeId: string): Promise<Fact>
  async readNode(kind: 'intent', nodeId: string): Promise<Intent>
  async readNode(kind: 'fact' | 'intent', nodeId: string): Promise<Fact | Intent> {
    return serial(this.root, async () => {
      await this.idle()
      await this.getProject()
      const node = await this.getNode(kind, nodeId) as Fact | Intent
      await this.idle()
      return node
    })
  }
  /** Journal paths/data are validated before replay; a journal cannot name arbitrary files. */
  private validateEntry(candidate: unknown): Entry {
    const entry = object(candidate, 'transaction entry')
    if (typeof entry.file !== 'string') throw new StoreError('事务路径无效')
    if (entry.file === 'project.json') validateProject(entry.value)
    else if (entry.file === 'meta.json') {
      if (object(entry.value, 'meta').format !== 1) throw new StoreError('meta 格式无效')
    } else if (entry.file === 'flags/ledger.json') {
      const ledger = object(entry.value, 'ledger')
      if (ledger.version !== 1 || !Array.isArray(ledger.entries)) throw new StoreError('ledger 格式无效')
    } else {
      const match = /^(facts|intents|hints)\/([a-z][a-z0-9_-]{0,16}\.json)$/.exec(entry.file)
      if (!match) throw new StoreError('事务包含越界或未知路径')
      const kind = match[1] === 'facts' ? 'fact' : match[1] === 'intents' ? 'intent' : 'hint'
      validateNode(entry.value, kind, match[2])
    }
    return { file: entry.file, value: entry.value }
  }
  private async replay(): Promise<void> {
    const file = await this.checked(journalName)
    if (!await exists(file)) return
    const journal = object(await readJson(file), 'transaction')
    if (journal.version !== 1 || !Array.isArray(journal.entries) || !journal.entries.length) throw new StoreError('事务日志损坏；已保留原文件，请先备份并检查')
    const entries = journal.entries.map(value => this.validateEntry(value))
    if (new Set(entries.map(entry => entry.file)).size !== entries.length) throw new StoreError('事务包含重复路径')
    for (const entry of entries) await this.checked(entry.file)
    // Once the journal exists, finish the commit even if a caller is cancelled.
    for (const entry of entries) await atomicJson(await this.checked(entry.file), entry.value)
    await unlink(file)
  }
  private async commit(changes: Changes, options: WriteOptions): Promise<void> {
    if (!changes.size) return
    changes.set('meta.json', { format: 1, writer: 'sapper-dsh', updated_at: now() })
    const entries = [...changes].map(([file, value]) => this.validateEntry({ file, value }))
    for (const entry of entries) await this.checked(entry.file)
    options.signal?.throwIfAborted()
    options.guard?.()
    await atomicJson(await this.checked(journalName), { version: 1, entries })
    await this.replay()
  }
  private async mutate<T>(operation: (changes: Changes) => Promise<T>, options: WriteOptions = {}): Promise<T> {
    return serial(this.root, async () => {
      options.signal?.throwIfAborted()
      options.guard?.()
      await safePath(this.root, this.boundary)
      await mkdir(this.root, { recursive: true })
      const lock = await this.checked(lockName)
      try { await mkdir(lock) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StoreError('LOCK 已存在；其他写者可能仍在运行。进程退出遗留锁需确认后手动清理，禁止直接重试覆盖')
        throw error
      }
      try {
        await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, created_at: now() })
        options.signal?.throwIfAborted()
        options.guard?.()
        await this.replay()
        const changes: Changes = new Map()
        const result = await operation(changes)
        await this.commit(changes, options)
        return result
      } finally { await rm(lock, { recursive: true }) }
    })
  }
  async recover(options?: WriteOptions): Promise<GraphSnapshot> {
    return this.mutate(async () => this.snapshot(), options)
  }
  async init(origin: string, goal: string, options?: WriteOptions): Promise<Project> {
    const target = text(goal, 'goal')
    if (typeof origin !== 'string') throw new StoreError('origin 必须是字符串')
    return this.mutate(async changes => {
      if (await this.initialized()) throw new StoreError('事实图已存在；初始化不会覆盖已有项目。M0 测试 fixture 请保留备份并在新目录初始化')
      const leftovers = (await readdir(this.root)).filter(name => name !== lockName && name !== '.lock')
      if (leftovers.length) throw new StoreError(`目录非空，拒绝初始化：${leftovers.slice(0, 5).join(', ')}`)
      const project: Project = { id: 'proj', origin: origin.trim(), goal: target, status: 'active', created_at: now(), counters: { fact: 0, intent: 0, hint: 0, run: 0 } }
      changes.set('facts/goal.json', { id: 'goal', description: target, created_at: now(), creator: 'system', source_intent: null })
      changes.set('project.json', project)
      return project
    }, options)
  }
  private async healthy(): Promise<GraphSnapshot> {
    const graph = await this.snapshot()
    if (graph.warnings.length || graph.integrity.length) throw new StoreError(`图存在损坏或悬空引用；写入已停止，原文件未修改：${[...graph.warnings, ...graph.integrity].join('; ')}`)
    return graph
  }
  private async nextId(project: Project, kind: 'fact' | 'intent' | 'hint', changes: Changes): Promise<string> {
    const prefix = kind[0]
    let number = project.counters[kind]
    let nodeId: string
    do {
      number++
      if (!Number.isSafeInteger(number)) throw new StoreError('ID 计数器已超出安全整数范围')
      nodeId = `${prefix}${String(number).padStart(3, '0')}`
      id(nodeId, kind)
    } while (await exists(await this.checked(`${nodeDir[kind]}/${nodeId}.json`)))
    project.counters[kind] = number
    changes.set('project.json', project)
    return nodeId
  }
  private makeFact(nodeId: string, input: FactInput, creator: string): Fact {
    const kind = nullable(input.kind, 'kind')?.toLowerCase() ?? null
    if (kind !== null && !FACT_KINDS.includes(kind as FactKind)) throw new StoreError('未知的事实 kind')
    const fact: Fact = {
      id: nodeId, title: nullable(input.title, 'title'), description: text(input.description, 'description'),
      doc: nullable(input.doc, 'doc'), kind: kind as FactKind | null, data: factData(input.data),
      created_at: now(), creator: text(creator, 'creator'), source_intent: input.source_intent ?? null,
    }
    if (kind === 'flag') {
      const entry = this.flagEntries([fact])[0]!
      if (entry.status !== 'recorded') throw new StoreError('新 flag 必须为 recorded；提交状态请通过 sapper_flag update 按会话写权限记录')
      fact.data = { ...fact.data, value: entry.value, status: entry.status }
    }
    return fact
  }
  private permission(intent: Intent, worker: string, autoConfirm = false): void {
    if (intent.to !== null) throw new StoreError(`${intent.id} 已结案`)
    if (intent.requires_confirmation && !intent.confirmed_at) {
      if (!autoConfirm) throw new StoreError(`${intent.id} 需要先通过 confirm 审批`)
      intent.confirmed_at = now()
      intent.confirmation_source = 'dsh-full-access'
    }
    if (intent.worker && intent.worker !== worker) throw new StoreError(`${intent.id} 已被 ${intent.worker} 领取`)
  }
  async addFact(input: FactInput, creator: string, options?: WriteOptions): Promise<Fact> {
    // Validate before any directory/lock write.
    const preview = this.makeFact('f001', input, creator)
    return this.mutate(async changes => {
      const graph = await this.healthy()
      if (preview.kind === 'flag') {
        const duplicate = this.flagEntries(graph.facts).find(entry => entry.value === preview.data?.value)
        if (duplicate) throw new StoreError(`flag 已记录为 ${duplicate.id}；请调用 sapper_flag 获取已有条目`)
      }
      let source: Intent | undefined
      if (input.source_intent != null) {
        id(input.source_intent, 'intent')
        source = await this.getNode('intent', input.source_intent) as Intent
        this.permission(source, creator, options?.autoConfirm?.())
      }
      const fact = this.makeFact(await this.nextId(graph.project, 'fact', changes), input, creator)
      changes.set(`facts/${fact.id}.json`, fact)
      if (fact.kind === 'flag') changes.set('flags/ledger.json', { version: 1, entries: this.flagEntries([...graph.facts, fact]) })
      if (source) {
        Object.assign(source, { to: fact.id, status: 'done', worker: creator, concluded_at: now() })
        changes.set(`intents/${source.id}.json`, source)
      }
      return fact
    }, options)
  }
  private dependencies(from: string[], facts: Fact[]): string[] {
    if (!Array.isArray(from) || !from.length) throw new StoreError('from 至少需要一个事实 ID')
    const values = [...new Set(from)]
    for (const dependency of values) {
      id(dependency, 'fact')
      if (dependency === 'goal' || !facts.some(f => f.id === dependency)) throw new StoreError(`依赖 ${dependency} 无效；goal 不能作为依赖`)
    }
    return values
  }
  async addIntent(input: IntentInput, creator: string, options?: WriteOptions): Promise<Intent> {
    text(input.description, 'description'); text(creator, 'creator')
    return this.mutate(async changes => {
      const graph = await this.healthy()
      const from = this.dependencies(input.from, graph.facts)
      const intent: Intent = {
        id: await this.nextId(graph.project, 'intent', changes), title: nullable(input.title, 'title'),
        from, to: null, description: input.description.trim(), doc: nullable(input.doc, 'doc'),
        status: 'open', worker: null, requires_confirmation: input.requires_confirmation ?? false,
        confirmed_at: null, concluded_at: null, created_at: now(), creator,
      }
      changes.set(`intents/${intent.id}.json`, intent)
      return intent
    }, options)
  }
  async intentAction(action: 'claim' | 'release' | 'confirm' | 'conclude', nodeId: string, worker: string, target?: string, options?: WriteOptions): Promise<Intent> {
    id(nodeId, 'intent'); text(worker, 'worker')
    return this.mutate(async changes => {
      const graph = await this.healthy()
      const intent = await this.getNode('intent', nodeId) as Intent
      if (intent.to !== null) throw new StoreError(`${nodeId} 已结案`)
      if (action === 'confirm') {
        if (!intent.requires_confirmation) throw new StoreError('该意图无需确认')
        if (intent.confirmed_at) {
          if (options?.autoConfirm?.()) return intent
          throw new StoreError('该意图已确认')
        }
        intent.confirmed_at = now()
        if (options?.autoConfirm?.()) intent.confirmation_source = 'dsh-full-access'
      } else if (action === 'release') {
        if (intent.worker && intent.worker !== worker) throw new StoreError(`意图已被 ${intent.worker} 领取`)
        intent.worker = null; intent.status = 'open'
      } else {
        this.permission(intent, worker, options?.autoConfirm?.())
        if (action === 'claim') { intent.worker = worker; intent.status = 'claimed' }
        else {
          id(target, 'fact')
          if (target === 'goal') {
            if (graph.project.status !== 'active') throw new StoreError('项目已完成')
            graph.project.status = 'completed'; graph.project.completed_at = now()
            changes.set('project.json', graph.project)
          } else {
            const fact = await this.getNode('fact', target!) as Fact
            if (fact.source_intent && fact.source_intent !== intent.id) throw new StoreError('目标事实已属于其他意图')
            fact.source_intent = intent.id
            changes.set(`facts/${fact.id}.json`, fact)
          }
          Object.assign(intent, { to: target, status: target === 'goal' ? 'complete' : 'done', worker, concluded_at: now() })
        }
      }
      changes.set(`intents/${nodeId}.json`, intent)
      return intent
    }, options)
  }
  async updateDoc(nodeId: string, doc: string | null, expectedDoc: string | null, options?: WriteOptions): Promise<Fact | Intent> {
    id(nodeId)
    const value = nullable(doc, 'doc')
    return this.mutate(async changes => {
      await this.healthy()
      const factFile = await this.checked(`facts/${nodeId}.json`)
      const kind = await exists(factFile) ? 'fact' : 'intent'
      const node = await this.getNode(kind, nodeId) as Fact | Intent
      if ((node.doc ?? null) !== expectedDoc) throw new StoreError('文档已被其他写者修改；请重新读取后再保存')
      node.doc = value
      changes.set(`${nodeDir[kind]}/${nodeId}.json`, node)
      return node
    }, options)
  }
  async addHint(content: string, creator: string, options?: WriteOptions): Promise<Hint> {
    const value = text(content, 'content'); text(creator, 'creator')
    return this.mutate(async changes => {
      const graph = await this.healthy()
      const hint: Hint = { id: await this.nextId(graph.project, 'hint', changes), content: value, creator, created_at: now() }
      changes.set(`hints/${hint.id}.json`, hint)
      return hint
    }, options)
  }
  flagEntries(facts: Fact[]): FlagEntry[] {
    return facts.filter(f => f.kind === 'flag').map(fact => {
      const data = fact.data ?? {}
      if (typeof data.value !== 'string' || !data.value.trim()) throw new StoreError(`${fact.id}: flag 缺少有效 data.value`)
      if (data.status && !FLAG_STATUSES.includes(data.status as FlagStatus)) throw new StoreError(`${fact.id}: flag status 无效`)
      return { id: fact.id, value: normalizeFlag(data.value), status: (data.status ?? 'recorded') as FlagStatus,
        source_fact: data.source_fact ?? null, challenge: data.challenge ?? '', captured_at: data.captured_at ?? fact.created_at, note: data.result ?? '' }
    })
  }
  async recordFlag(value: string, creator: string, details: { source_fact?: string | undefined; challenge?: string | undefined; note?: string | undefined } = {}, options?: WriteOptions): Promise<{ entry: FlagEntry; duplicate: boolean }> {
    const normalized = normalizeFlag(value)
    text(creator, 'creator')
    return this.mutate(async changes => {
      const graph = await this.healthy()
      const entries = this.flagEntries(graph.facts)
      const existing = entries.find(entry => entry.value === normalized)
      if (existing) {
        changes.set('flags/ledger.json', { version: 1, entries })
        return { entry: existing, duplicate: true }
      }
      if (details.source_fact) await this.getNode('fact', details.source_fact)
      const fact = this.makeFact(await this.nextId(graph.project, 'fact', changes), {
        description: `flag captured: ${normalized}`, title: 'flag', kind: 'flag',
        data: { value: normalized, status: 'recorded', source_fact: details.source_fact ?? null,
          challenge: details.challenge ?? '', result: details.note ?? '', captured_at: now() },
      }, creator)
      changes.set(`facts/${fact.id}.json`, fact)
      const entry = this.flagEntries([fact])[0]!
      changes.set('flags/ledger.json', { version: 1, entries: [...entries, entry] })
      return { entry, duplicate: false }
    }, options)
  }
  async updateFlag(nodeId: string, status: FlagStatus, note: string | undefined, options?: WriteOptions): Promise<FlagEntry> {
    id(nodeId, 'fact')
    if (!FLAG_STATUSES.includes(status)) throw new StoreError('无效的 flag 状态')
    return this.mutate(async changes => {
      const graph = await this.healthy()
      const fact = await this.getNode('fact', nodeId) as Fact
      if (fact.kind !== 'flag') throw new StoreError(`${nodeId} 不是 flag 事实`)
      fact.data = { ...factData(fact.data), status, ...(note === undefined ? {} : { result: note }) }
      const facts = graph.facts.map(f => f.id === nodeId ? fact : f)
      const entries = this.flagEntries(facts)
      changes.set(`facts/${nodeId}.json`, fact)
      changes.set('flags/ledger.json', { version: 1, entries })
      return entries.find(entry => entry.id === nodeId)!
    }, options)
  }
}

/** Preserve case: most flags are case-sensitive. Normalize width and surrounding whitespace only. */
export function normalizeFlag(value: string): string { return text(value, 'flag').normalize('NFKC').trim() }
