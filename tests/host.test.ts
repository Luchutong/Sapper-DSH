import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import { GraphStore } from '../src/store/graph.js'
import { fact, intent } from './fixtures/graph.js'
import { KnowledgeBase } from '../src/kb/index.js'

/** Test persistence only; forms, validation and live updates use the real SDK. */
class TestConfigEditor extends Service {
  static inject = ['loader']
  writes = 0
  documentPath: string
  constructor(ctx: Context, config: { cwd: string }) {
    super(ctx, 'configEditor')
    this.documentPath = path.join(config.cwd, 'profile.patch.json')
  }
  entries() { return [...this.ctx.loader.entries()] }
  configuration() {
    return this.entries().map(entry => ({ entry, inherited: {}, override: entry.options.config ?? {} }))
  }
  async edit(entry: Entry, change: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => object) {
    const config = change(entry.options.config ?? {}, {})
    await entry.update({ config })
    await writeFile(this.documentPath, JSON.stringify(config), 'utf8')
    this.writes++
  }
}

/** Real Cordis lifecycle and real SDK definitions, with no model/provider/network. */
class ToolsProbe extends Service {
  definitions = new Map<string, ToolDefinition>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: ToolDefinition) {
    return this.ctx.effect(() => {
      this.definitions.set(tool.name, tool)
      return () => { this.definitions.delete(tool.name) }
    })
  }
  guard() { return this.ctx.effect(() => () => {}) }
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function setup(enabled = true) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper 中文 '))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(ToolsProbe)
  ctx.provide('agents', {})
  ctx.provide('profileContext', { home: cwd })
  await ctx.plugin(TestConfigEditor, { cwd })
  await ctx.plugin(SettingsForms)
  const loader = ctx.loader
  loader.builtins.sapper = plugin
  const options = { id: 'sapper', name: 'cordis:sapper', config: {
    enabled, store: { mode: 'workspace', dir: '.sapper' }, orchestration: { requireApproval: true },
  } }
  await loader.create(options)
  await loader.await()
  const fiber = loader.resolve('sapper').fiber!
  const tools = ctx.get('tools') as unknown as ToolsProbe
  const settings = ctx.settings
  const editor = ctx.get('configEditor') as unknown as TestConfigEditor
  return { ctx, tools, settings, editor, loader, fiber, cwd }
}

async function seed(cwd: string, content: string) {
  const root = path.join(cwd, '.sapper')
  await mkdir(root)
  await writeFile(path.join(root, 'project.json'), content, 'utf8')
}

async function preStep(ctx: Context, cwd: string, messages: UserMessage[] = [createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })]) {
  const decision = await ctx.waterfall('agent/pre-step', {
    agent: { session: { header: { cwd } } } as Agent, messages, turn: 1, step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages }))
  if (decision.kind === 'reject') throw new Error('unexpected rejected test step')
  return decision
}

describe('host lifecycle integration', () => {
  it('loads using real Cordis, reads an absent graph without creating files or settings', async () => {
    const { tools, editor, cwd } = await setup()
    expect([...tools.definitions.keys()]).toEqual(['sapper_status', 'sapper_init', 'sapper_fact', 'sapper_intent', 'sapper_doc', 'sapper_flag', 'sapper_recall', 'sapper_kb'])
    const tool = tools.definitions.get('sapper_status')!
    const value = await tool.execute({}, { agent: { session: { header: { cwd } } }, signal: new AbortController().signal } as never)
    expect(value).toMatchObject({ state: 'uninitialized', milestone: 'M2-context' })
    expect(await readdir(cwd)).toEqual([])
    expect(editor.writes).toBe(0)
  })

  it('injects one source-marked snapshot, deduplicates it and removes it when disabled', async () => {
    const { ctx, settings, tools, fiber, loader, editor, cwd } = await setup()
    const content = JSON.stringify({ goal: '读取证据', status: 'active' })
    await seed(cwd, content)
    const first = await preStep(ctx, cwd)
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(2)
    expect(first.messages[1]!.source).toMatchObject({ kind: 'sapper-dsh', form: 'snapshot' })
    expect((await preStep(ctx, cwd, first.messages)).messages).toHaveLength(2)
    await settings.update('sapper', { enabled: false })
    expect(tools.definitions.size).toBe(0)
    expect(loader.resolve('sapper').fiber).toBe(fiber)
    expect(JSON.parse(await readFile(editor.documentPath, 'utf8'))).toMatchObject({ enabled: false })
    expect((await preStep(ctx, cwd, first.messages)).messages).toHaveLength(1)
    await settings.update('sapper', { enabled: true })
    expect(tools.definitions.size).toBe(8)
    expect(await readFile(path.join(cwd, '.sapper/project.json'), 'utf8')).toBe(content)
    await fiber.dispose()
    expect(tools.definitions.size).toBe(0)
    expect(settings.describe().some(row => row.ns === 'sapper')).toBe(false)
    expect((await preStep(ctx, cwd)).messages).toHaveLength(1)
  })

  it('does not inject into an empty or cancelled step, or without a graph', async () => {
    const { ctx, cwd } = await setup()
    expect((await preStep(ctx, cwd)).messages).toHaveLength(1)
    await seed(cwd, JSON.stringify({ goal: 'test', status: 'active' }))
    expect((await preStep(ctx, cwd, [])).messages).toHaveLength(0)
    const result = await ctx.waterfall('agent/pre-step', {
      agent: { session: { header: { cwd } } } as Agent, messages: [], turn: 1, step: 1,
      signal: AbortSignal.abort(),
    }, async () => ({ kind: 'reject' }))
    expect(result).toEqual({ kind: 'reject' })
  })

  it('contains malformed graph data without changing it', async () => {
    const { ctx, tools, cwd } = await setup()
    await seed(cwd, '{broken')
    expect((await preStep(ctx, cwd)).messages).toHaveLength(1)
    await expect(tools.definitions.get('sapper_status')!.execute({}, {
      agent: { session: { header: { cwd } } }, signal: new AbortController().signal,
    } as never)).rejects.toThrow()
    expect(await readFile(path.join(cwd, '.sapper/project.json'), 'utf8')).toBe('{broken')
  })

  it('exposes the entry Config form while starting disabled', async () => {
    const { tools, settings, cwd, ctx } = await setup(false)
    expect(settings.describe().find(row => row.ns === 'sapper')).toMatchObject({ value: { enabled: false }, autoGenerate: false })
    expect(tools.definitions.size).toBe(0)
    expect((await preStep(ctx, cwd)).messages).toHaveLength(1)
  })

  it('rejects stale settings writes using the new form revision fence', async () => {
    const { settings, tools } = await setup()
    const revision = settings.describe().find(row => row.ns === 'sapper')!.revision
    await settings.update('sapper', { enabled: false }, revision)
    await expect(settings.update('sapper', { enabled: true }, revision)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
    expect(tools.definitions.size).toBe(0)
  })
  it('derives the new storage policy for legacy entries and persists explicit manual mode', async () => {
    const { settings, editor } = await setup()
    expect(settings.describe().find(row => row.ns === 'sapper')).toMatchObject({ value: { store: { approval: 'session' } } })
    await settings.mutate('sapper', [{ op: 'set', path: ['store', 'approval'], value: 'always' }])
    expect(settings.describe().find(row => row.ns === 'sapper')).toMatchObject({ value: { store: { approval: 'always' } } })
    expect(JSON.parse(await readFile(editor.documentPath, 'utf8'))).toMatchObject({ store: { approval: 'always', dir: '.sapper' }, orchestration: { requireApproval: true } })
  })
  it('injects frontier/history/automatic recall/KB under one budget without reading doc bodies into context', async () => {
    const { ctx, cwd, settings } = await setup()
    const store = new GraphStore(path.join(cwd, '.sapper'), cwd)
    await store.init('host test', 'Web 信息收集')
    const node = await store.addFact({ title: 'Tomcat service', description: 'Tomcat observed', doc: 'HOST-DOC-SECRET' }, 'test')
    await store.addIntent({ from: [node.id], description: 'Inspect Tomcat' }, 'test')
    await store.addHint('Reuse existing evidence', 'test')
    await settings.update('sapper', { context: { scope: 'frontier-history', historyFacts: 0 } })
    const messages = [createUserMessage({ content: [{ type: 'text', text: '检查 Tomcat 服务，参考 Web 信息收集 工作流' }], source: { kind: 'user' } })]
    const before = await readFile(path.join(cwd, '.sapper/project.json'), 'utf8')
    const result = await preStep(ctx, cwd, messages)
    const text = JSON.stringify(result.messages[1]?.content)
    expect(text).toContain('Frontier/ready:')
    expect(text).toContain('Recall:')
    expect(text).toContain('KB:')
    expect(text).toContain('kb001')
    expect(text).toContain('Hint:')
    expect(text).not.toContain('HOST-DOC-SECRET')
    expect(await readFile(path.join(cwd, '.sapper/project.json'), 'utf8')).toBe(before)
    await settings.update('sapper', { context: { recallAuto: false }, kb: { enabled: false } })
    const plain = JSON.stringify((await preStep(ctx, cwd, messages)).messages[1]?.content)
    expect(plain).toContain('Frontier/ready:')
    expect(plain).not.toContain('Recall:')
    expect(plain).not.toContain('KB:')
    await settings.update('sapper', { context: { inject: false } })
    expect((await preStep(ctx, cwd, result.messages)).messages).toEqual(messages)
  })
  it('injects a real 500-node disk graph within budget and performs no graph read when injection is disabled', async () => {
    const { ctx, cwd, settings } = await setup()
    const store = new GraphStore(path.join(cwd, '.sapper'), cwd)
    await store.init('large host graph', '500 nodes')
    const factsDir = path.join(cwd, '.sapper/facts'), intentsDir = path.join(cwd, '.sapper/intents')
    await mkdir(intentsDir)
    await Promise.all([
      ...Array.from({ length: 250 }, (_, n) => writeFile(path.join(factsDir, `f${String(n + 1).padStart(3, '0')}.json`), JSON.stringify(fact(`f${String(n + 1).padStart(3, '0')}`, `Evidence ${n}`)))),
      ...Array.from({ length: 249 }, (_, n) => writeFile(path.join(intentsDir, `i${String(n + 1).padStart(3, '0')}.json`), JSON.stringify(intent(`i${String(n + 1).padStart(3, '0')}`)))),
    ])
    await settings.update('sapper', { context: { maxChars: 1024 }, kb: { enabled: false } })
    const result = await preStep(ctx, cwd)
    const block = result.messages[1]!.content[0]!
    expect(block.type).toBe('text')
    if (block.type === 'text') {
      expect(block.text.length).toBeLessThanOrEqual(1024)
      expect(block.text).toContain('omitted')
    }
    await settings.update('sapper', { context: { inject: false } })
    const read = vi.spyOn(GraphStore.prototype, 'read')
    const initialized = vi.spyOn(GraphStore.prototype, 'initialized')
    const knowledge = vi.spyOn(KnowledgeBase.prototype, 'read')
    await writeFile(path.join(cwd, '.sapper/project.json'), '{broken')
    expect((await preStep(ctx, cwd, result.messages)).messages).toHaveLength(1)
    expect(read).not.toHaveBeenCalled()
    expect(initialized).not.toHaveBeenCalled()
    expect(knowledge).not.toHaveBeenCalled()
    expect(await readFile(path.join(cwd, '.sapper/project.json'), 'utf8')).toBe('{broken')
  })
})
