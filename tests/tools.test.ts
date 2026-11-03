import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRuntime } from '../src/dsh-adapter/host.js'
import { resolveConfig } from '../src/settings.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function setup(outcome: string | undefined = 'allowed-once', requireApproval = true) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper tools 中文 '))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  await ctx.plugin(ToolRuntime)
  let config = resolveConfig({ orchestration: { requireApproval } })
  registerRuntime(ctx, () => config)
  const request = vi.fn(async (_input: unknown) => outcome)
  if (outcome !== undefined) ctx.provide('approval', { request })
  const agent = { id: 'test-session', session: { header: { cwd } } } as unknown as Agent
  let call = 0
  const execute = (name: string, args: unknown, signal = new AbortController().signal) => ctx.tools.execute({
    name, arguments: args, agent, callId: `tool-${++call}` as never, signal,
  })
  const setConfig = (input: Parameters<typeof resolveConfig>[0]) => { config = resolveConfig(input) }
  return { ctx, cwd, execute, request, setConfig, agent }
}
function value(result: ToolExecutionResult): Record<string, any> {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, any>
}

describe('real DSH ToolRuntime and M1 approval pipeline', () => {
  it('registers six tools, approves initialization, and reads status without further approval', async () => {
    const { execute, request, cwd } = await setup()
    expect(value(await execute('sapper_status', {}))).toMatchObject({ state: 'uninitialized', milestone: 'M1-storage' })
    expect(await readdir(cwd)).toEqual([])
    expect(request).not.toHaveBeenCalled()
    expect(value(await execute('sapper_init', { goal: 'tool integration' }))).toMatchObject({ goal: 'tool integration' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(value(await execute('sapper_status', {}))).toMatchObject({ state: 'active', counts: { facts: 0, intents: 0 } })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(['rejected', 'cancelled', 'unavailable'])('does not create directories when approval is %s', async outcome => {
    const { execute, cwd } = await setup(outcome)
    expect((await execute('sapper_init', { goal: 'must not write' })).isError).toBe(true)
    expect(await readdir(cwd)).toEqual([])
  })
  it('fails closed when the approval service is absent', async () => {
    const { ctx, execute, cwd } = await setup()
    // Removing a provided service simulates an unmounted approval channel.
    ctx.set('approval', undefined)
    expect((await execute('sapper_init', { goal: 'must not write' })).isError).toBe(true)
    expect(await readdir(cwd)).toEqual([])
  })
  it('executes fact/intent/doc/flag operations with canonical outputs and session-owned identity', async () => {
    const { execute } = await setup()
    value(await execute('sapper_init', { goal: 'round trip' }))
    const fact = value(await execute('sapper_fact', { action: 'create', description: 'Observed host', kind: 'host', data: { host: 'localhost', port: 80 }, creator: 'spoofed' }))
    expect(fact).toMatchObject({ id: 'f001', creator: 'test-session', data: { port: '80' } })
    const intent = value(await execute('sapper_intent', { action: 'create', from: [fact.id], description: 'Inspect local fixture' }))
    value(await execute('sapper_intent', { action: 'claim', id: intent.id }))
    const produced = value(await execute('sapper_fact', { action: 'create', source_intent: intent.id, description: 'Fixture evidence', doc: 'raw evidence' }))
    expect(value(await execute('sapper_intent', { action: 'get', id: intent.id }))).toMatchObject({ to: produced.id, status: 'done', worker: 'test-session' })
    expect(value(await execute('sapper_fact', { action: 'get', id: fact.id })).id).toBe(fact.id)
    expect(value(await execute('sapper_doc', { action: 'get', id: produced.id })).doc).toBe('raw evidence')
    value(await execute('sapper_doc', { action: 'set', id: produced.id, doc: 'updated', expected_doc: 'raw evidence' }))
    expect((await execute('sapper_doc', { action: 'set', id: produced.id, doc: 'stale', expected_doc: 'raw evidence' })).isError).toBe(true)
    expect(value(await execute('sapper_fact', { action: 'list' })).facts.find((f: any) => f.id === produced.id)).not.toHaveProperty('doc')
    expect(value(await execute('sapper_intent', { action: 'list' })).intents).toHaveLength(1)
    const flag = value(await execute('sapper_flag', { action: 'record', value: 'flag{LOCAL-FIXTURE}', source_fact: produced.id }))
    expect(flag.duplicate).toBe(false)
    expect(value(await execute('sapper_flag', { action: 'record', value: ' flag{LOCAL-FIXTURE} ' })).duplicate).toBe(true)
    value(await execute('sapper_flag', { action: 'update', id: flag.entry.id, status: 'rejected', note: 'local test only' }))
    expect(value(await execute('sapper_flag', { action: 'list' })).entries[0].status).toBe('rejected')
    expect(value(await execute('sapper_status', {}))).toMatchObject({ counts: { facts: 3, flags: 1 }, warnings: [], integrity: [] })
  })
  it('keeps confirmation, project completion and flag lifecycle approval mandatory when ordinary write prompts are disabled', async () => {
    const { execute, request } = await setup('allowed-once', false)
    value(await execute('sapper_init', { goal: 'gated completion' }))
    const fact = value(await execute('sapper_fact', { action: 'create', description: 'seed' }))
    const intent = value(await execute('sapper_intent', { action: 'create', from: [fact.id], description: 'finish', requires_confirmation: true }))
    expect(request).not.toHaveBeenCalled()
    expect((await execute('sapper_intent', { action: 'claim', id: intent.id })).isError).toBe(true)
    value(await execute('sapper_intent', { action: 'confirm', id: intent.id }))
    expect(request).toHaveBeenCalledTimes(1)
    value(await execute('sapper_intent', { action: 'conclude', id: intent.id, to: 'goal' }))
    expect(request).toHaveBeenCalledTimes(2)
    const flag = value(await execute('sapper_flag', { action: 'record', value: 'flag{LOCAL}' }))
    value(await execute('sapper_flag', { action: 'update', id: flag.entry.id, status: 'submitted' }))
    expect(request).toHaveBeenCalledTimes(3)
  })
  it.each([
    { enabled: false }, { store: { dir: 'changed-store' } }, { goal: 'changed goal' },
  ])('blocks a previously approved call if its configuration changes while awaiting approval: %j', async input => {
    const { execute, request, setConfig, cwd } = await setup()
    request.mockImplementationOnce(async () => { setConfig(input); return 'allowed-once' })
    expect((await execute('sapper_init', { goal: 'must not write' })).isError).toBe(true)
    expect(await readdir(cwd)).toEqual([])
  })
  it('preserves another policy denial and respects cancellation before dispatch', async () => {
    const { ctx, execute, request, cwd } = await setup()
    ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'deployment policy' }))
    expect((await execute('sapper_init', { goal: 'blocked' })).isError).toBe(true)
    expect((await execute('sapper_init', { goal: 'cancelled' }, AbortSignal.abort())).isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(await readdir(cwd)).toEqual([])
  })
  it('validates arguments and blocks stale tool handles after plugin disposal', async () => {
    const { execute, ctx, cwd, agent } = await setup()
    expect((await execute('sapper_fact', { action: 'unknown' })).isError).toBe(true)
    const stale = ctx.tools.get('sapper_init')!
    await ctx.fiber.dispose()
    await expect(stale.execute({ goal: 'stale' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('卸载')
    expect(await readdir(cwd)).toEqual([])
  })
})
