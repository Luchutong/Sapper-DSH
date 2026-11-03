import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  writes = 0
  protected async load() { return {} }
  protected async persist(_ns: SettingsNamespace, _section: Record<string, unknown>) { this.writes++ }
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
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function setup(enabled = true) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper 中文 '))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(MemorySettings)
  await ctx.plugin(ToolsProbe)
  ctx.provide('agents', {})
  const fiber = await ctx.plugin(plugin, { enabled })
  const tools = ctx.get('tools') as unknown as ToolsProbe
  const settings = ctx.get('settings') as MemorySettings
  return { ctx, tools, settings, fiber, cwd }
}

async function seed(cwd: string, content: string) {
  const root = path.join(cwd, '.sapper')
  await mkdir(root)
  await writeFile(path.join(root, 'project.json'), content, 'utf8')
}

async function preStep(ctx: Context, cwd: string, messages = [createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })]) {
  const decision = await ctx.waterfall('agent/pre-step', {
    agent: { session: { header: { cwd } } } as Agent, messages, turn: 1, step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages }))
  if (decision.kind === 'reject') throw new Error('unexpected rejected test step')
  return decision
}

describe('host M0 integration', () => {
  it('loads using real Cordis, reads an absent graph without creating files or settings', async () => {
    const { tools, settings, cwd } = await setup()
    expect([...tools.definitions.keys()]).toEqual(['sapper_status'])
    const tool = tools.definitions.get('sapper_status')!
    const value = await tool.execute({}, { agent: { session: { header: { cwd } } }, signal: new AbortController().signal } as never)
    expect(value).toMatchObject({ state: 'uninitialized', milestone: 'M0-scaffold' })
    expect(await readdir(cwd)).toEqual([])
    expect(settings.writes).toBe(0)
  })

  it('injects one source-marked snapshot, deduplicates it and removes it when disabled', async () => {
    const { ctx, settings, tools, fiber, cwd } = await setup()
    const content = JSON.stringify({ goal: '读取证据', status: 'active' })
    await seed(cwd, content)
    const first = await preStep(ctx, cwd)
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(2)
    expect(first.messages[1]!.source).toMatchObject({ plugin: 'sapper-dsh', form: 'snapshot' })
    expect((await preStep(ctx, cwd, first.messages)).messages).toHaveLength(2)
    await settings.update('sapper', { enabled: false })
    expect(tools.definitions.size).toBe(0)
    expect((await preStep(ctx, cwd, first.messages)).messages).toHaveLength(1)
    await settings.update('sapper', { enabled: true })
    expect(tools.definitions.size).toBe(1)
    expect(await readFile(path.join(cwd, '.sapper/project.json'), 'utf8')).toBe(content)
    await fiber.dispose()
    expect(tools.definitions.size).toBe(0)
    expect(settings.get('sapper')).toBeUndefined()
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

  it('registers the settings namespace while starting disabled', async () => {
    const { tools, settings, cwd, ctx } = await setup(false)
    expect(settings.get('sapper')).toMatchObject({ enabled: false })
    expect(tools.definitions.size).toBe(0)
    expect((await preStep(ctx, cwd)).messages).toHaveLength(1)
  })
})
