import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { registerRuntime } from '../src/dsh-adapter/host.js'
import { resolveConfig } from '../src/settings.js'
import { GraphStore } from '../src/store/graph.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
async function setup() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper commands 中文 ')); cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  ctx.provide('tools', { register: () => () => {}, guard: () => () => {} })
  await ctx.plugin(CommandRuntime)
  let config = resolveConfig()
  registerRuntime(ctx, () => config)
  const events: string[] = []
  const agent = { id: 'test', session: { id: 'test', header: { cwd }, append: (type: string) => { events.push(type); return { seq: events.length } } } } as unknown as Agent
  const run = async (line: string, signal = new AbortController().signal) => (await ctx.commands.execute(agent, line, [], signal))?.result
  const setEnabled = (enabled: boolean) => { config = resolveConfig({ enabled }); ctx.emit('loader/volatile-update', []) }
  return { ctx, cwd, agent, events, run, setEnabled, store: new GraphStore(path.join(cwd, '.sapper'), cwd) }
}
describe('real DSH /sapper command registry', () => {
  it('discovers the command, returns uninitialized without writes, and loads KB without a graph/model', async () => {
    const { ctx, agent, run, cwd, events } = await setup()
    expect(ctx.commands.list(agent).map(c => c.name)).toContain('sapper')
    expect(await run('/sapper status')).toMatchObject({ kind: 'success', text: expect.stringContaining('uninitialized') })
    expect(await run('/sapper kb Web 信息收集')).toMatchObject({ kind: 'success', text: expect.stringContaining('kb001') })
    expect(await readdir(cwd)).toEqual([])
    expect(events).toEqual(['command/run', 'command/done', 'command/run', 'command/done'])
  })
  it('routes graph/frontier/recall/flag reads, validates usage and supports cancellation', async () => {
    const { store, run } = await setup()
    await store.init('test', 'commands')
    const fact = await store.addFact({ description: 'Tomcat fixture', title: 'Tomcat service', doc: 'DOC-SECRET' }, 'test')
    await store.addIntent({ from: [fact.id], description: 'Inspect fixture' }, 'test')
    await store.recordFlag('flag{COMMAND-LOCAL}', 'test')
    expect(await run('/sapper')).toMatchObject({ kind: 'success', text: expect.stringContaining('active') })
    const graph = await run('/sapper graph')
    expect(graph).toMatchObject({ kind: 'success', text: expect.stringContaining('Tomcat service') })
    expect(graph?.text).not.toContain('DOC-SECRET')
    expect(await run('/sapper frontier')).toMatchObject({ kind: 'success', text: expect.stringContaining('i001') })
    expect(await run('/sapper recall tomcat')).toMatchObject({ kind: 'success', text: expect.stringContaining('f001') })
    expect(await run('/sapper flag')).toMatchObject({ kind: 'success', text: expect.stringContaining('flag{COMMAND-LOCAL}') })
    expect(await run('/sapper recall')).toMatchObject({ kind: 'error' })
    expect(await run('/sapper bogus')).toMatchObject({ kind: 'error' })
    expect(await run('/sapper flag update')).toMatchObject({ kind: 'error' })
    await expect(run('/sapper graph', AbortSignal.abort())).rejects.toThrow()
  })
  it('unregisters on disable/unload and rejects captured stale handlers', async () => {
    const { ctx, agent, setEnabled, run } = await setup()
    const definition = ctx.commands.find(agent, 'sapper')!
    setEnabled(false)
    expect(await run('/sapper')).toBeUndefined()
    setEnabled(true)
    expect(ctx.commands.find(agent, 'sapper')).toBeDefined()
    await ctx.fiber.dispose()
    expect(await definition.handler({ agent, commandId: 'stale' as never, rawInput: 'status', attachments: [], signal: new AbortController().signal })).toMatchObject({ kind: 'error', text: expect.stringContaining('关闭') })
  })
})
