import { executeTool } from '../src/dsh-adapter/runtime.js'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRuntime } from '../src/dsh-adapter/host.js'
import { resolveConfig } from '../src/settings.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function setup(outcome: string | undefined = 'allowed-once', approval: 'session' | 'always' = 'session', initialMode: SandboxMode = 'workspace-write') {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper tools 中文 '))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, context: () => () => {}, getContextOrder: () => 0 })
  let mode = initialMode
  ctx.provide('sessionProjections', { register: () => ({ stateOf: () => mode }) })
  const policyFiber = await ctx.plugin(SandboxPolicyService, { mode: initialMode, workspaceRoot: cwd })
  await ctx.plugin(ToolRuntime)
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  let config = resolveConfig({ store: { approval }, orchestration: { requireApproval: true } })
  registerRuntime(ctx, () => config)
  const request = vi.fn(async (_input: unknown) => outcome)
  if (outcome !== undefined) ctx.provide('approval', { request })
  const agent = { id: 'test-session', session: { id: 'test-session', header: { cwd } } } as unknown as Agent
  let call = 0
  const execute = (name: string, args: unknown, signal = new AbortController().signal) => executeTool(ctx.tools, {
    name, arguments: args, agent, callId: `tool-${++call}` as never, signal,
  })
  const setConfig = (input: Parameters<typeof resolveConfig>[0]) => { config = resolveConfig(input) }
  const setMode = (next: SandboxMode) => { mode = next }
  return { ctx, cwd, execute, request, setConfig, setMode, agent, disposePolicy: () => policyFiber.dispose() }
}
function value(result: ToolExecutionResult): Record<string, any> {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, any>
}

describe('real DSH ToolRuntime and M1 approval pipeline', () => {
  it('registers nine tools, approves initialization, and reads status without further approval', async () => {
    const { execute, request, cwd } = await setup('allowed-once', 'always')
    expect(value(await execute('sapper_status', {}))).toMatchObject({ state: 'uninitialized', milestone: 'M3-orchestration' })
    expect(await readdir(cwd)).toEqual([])
    expect(request).not.toHaveBeenCalled()
    expect(value(await execute('sapper_init', { goal: 'tool integration' }))).toMatchObject({ goal: 'tool integration' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(value(await execute('sapper_status', {}))).toMatchObject({ state: 'active', counts: { facts: 0, intents: 0 } })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(['rejected', 'cancelled', 'unavailable'])('does not create directories when approval is %s', async outcome => {
    const { execute, cwd } = await setup(outcome, 'always')
    expect((await execute('sapper_init', { goal: 'must not write' })).isError).toBe(true)
    expect(await readdir(cwd)).toEqual([])
  })
  it('fails closed when the approval service is absent', async () => {
    const { ctx, execute, cwd } = await setup('allowed-once', 'always')
    // Removing a provided service simulates an unmounted approval channel.
    ctx.set('approval', undefined)
    expect((await execute('sapper_init', { goal: 'must not write' })).isError).toBe(true)
    expect(await readdir(cwd)).toEqual([])
  })
  it('executes fact/intent/doc/flag operations with canonical outputs and session-owned identity', async () => {
    const { execute, request } = await setup()
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
    expect(request).not.toHaveBeenCalled()
  })
  it('completes ordinary metadata work with a never-style answerer without asking once', async () => {
    const { execute, request } = await setup('rejected', 'session', 'danger-full-access')
    value(await execute('sapper_init', { goal: 'automatic metadata' }))
    const fact = value(await execute('sapper_fact', { action: 'create', description: 'seed', doc: 'v1' }))
    value(await execute('sapper_doc', { action: 'set', id: fact.id, doc: 'v2', expected_doc: 'v1' }))
    const intent = value(await execute('sapper_intent', { action: 'create', from: [fact.id], description: 'inspect' }))
    expect((await execute('sapper_intent', { action: 'confirm', id: intent.id })).isError).toBe(true)
    value(await execute('sapper_intent', { action: 'claim', id: intent.id }))
    const result = value(await execute('sapper_fact', { action: 'create', description: 'evidence', source_intent: intent.id }))
    const flag = value(await execute('sapper_flag', { action: 'record', value: 'flag{LOCAL}' }))
    value(await execute('sapper_flag', { action: 'update', id: flag.entry.id, status: 'submitted' }))
    const completion = value(await execute('sapper_intent', { action: 'create', from: [result.id], description: 'finish' }))
    value(await execute('sapper_intent', { action: 'conclude', id: completion.id, to: 'goal' }))
    expect(value(await execute('sapper_status', {}))).toMatchObject({ state: 'completed', store_approval: 'session', integrity: [] })
    expect(request).not.toHaveBeenCalled()
  })
  it('retains the explicit human gate only for intents deliberately marked as requiring confirmation', async () => {
    const { execute, request } = await setup('allowed-once')
    value(await execute('sapper_init', { goal: 'optional gate' }))
    const fact = value(await execute('sapper_fact', { action: 'create', description: 'seed' }))
    const intent = value(await execute('sapper_intent', { action: 'create', from: [fact.id], description: 'human decision', requires_confirmation: true }))
    expect((await execute('sapper_intent', { action: 'claim', id: intent.id })).isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
    value(await execute('sapper_intent', { action: 'confirm', id: intent.id }))
    expect(request).toHaveBeenCalledTimes(1)
    value(await execute('sapper_intent', { action: 'claim', id: intent.id }))
    value(await execute('sapper_intent', { action: 'conclude', id: intent.id, to: 'goal' }))
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(['session', 'always'] as const)('treats full access as a standing grant for confirmation-required work, including %s mode', async approval => {
    const { execute, request } = await setup('rejected', approval, 'danger-full-access')
    value(await execute('sapper_init', { goal: 'full access automation' }))
    const seed = value(await execute('sapper_fact', { action: 'create', description: 'seed' }))
    const explicit = value(await execute('sapper_intent', { action: 'create', from: [seed.id], description: 'explicit confirm', requires_confirmation: true }))
    value(await execute('sapper_intent', { action: 'confirm', id: explicit.id }))
    value(await execute('sapper_intent', { action: 'claim', id: explicit.id }))
    expect(value(await execute('sapper_intent', { action: 'get', id: explicit.id }))).toMatchObject({ confirmation_source: 'dsh-full-access', status: 'claimed' })
    const implicit = value(await execute('sapper_intent', { action: 'create', from: [seed.id], description: 'implicit confirm', requires_confirmation: true }))
    expect(value(await execute('sapper_status', { view: 'frontier' })).frontier.ready.ids).toContain(implicit.id)
    expect(value(await execute('sapper_intent', { action: 'get', id: implicit.id })).confirmed_at).toBeNull()
    value(await execute('sapper_intent', { action: 'claim', id: implicit.id }))
    expect(value(await execute('sapper_intent', { action: 'get', id: implicit.id }))).toMatchObject({ confirmation_source: 'dsh-full-access', status: 'claimed' })
    const produced = value(await execute('sapper_intent', { action: 'create', from: [seed.id], description: 'result shortcut', requires_confirmation: true }))
    value(await execute('sapper_fact', { action: 'create', description: 'result evidence', source_intent: produced.id }))
    expect(value(await execute('sapper_intent', { action: 'get', id: produced.id }))).toMatchObject({ confirmation_source: 'dsh-full-access', status: 'done' })
    const done = value(await execute('sapper_intent', { action: 'create', from: [seed.id], description: 'complete', requires_confirmation: true }))
    value(await execute('sapper_intent', { action: 'conclude', id: done.id, to: 'goal' }))
    expect(value(await execute('sapper_status', {})).state).toBe('completed')
    expect(request).not.toHaveBeenCalled()
  })
  it('does not turn another DSH policy ask into allow even in full access', async () => {
    const { ctx, execute, request, cwd } = await setup('rejected', 'session', 'danger-full-access')
    ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'another plugin policy' }))
    expect((await execute('sapper_init', { goal: 'external policy' })).isError).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(await readdir(cwd)).toEqual([])
  })
  it('rechecks full-access authorization before auto-confirming when the session mode changes', async () => {
    const { ctx, execute, setMode } = await setup('rejected', 'session', 'danger-full-access')
    value(await execute('sapper_init', { goal: 'mode downgrade' }))
    const seed = value(await execute('sapper_fact', { action: 'create', description: 'seed' }))
    const intent = value(await execute('sapper_intent', { action: 'create', from: [seed.id], description: 'pending', requires_confirmation: true }))
    ctx.on('tools/execute', async (exec, next) => { if (exec.name === 'sapper_intent') setMode('workspace-write'); return next() })
    expect((await execute('sapper_intent', { action: 'claim', id: intent.id })).isError).toBe(true)
    expect(value(await execute('sapper_intent', { action: 'get', id: intent.id }))).toMatchObject({ status: 'open', confirmed_at: null, worker: null })
  })
  it('runs M2 recall/KB as readonly tools and returns no expanded document in search results', async () => {
    const { execute, request, setMode, setConfig } = await setup()
    value(await execute('sapper_init', { goal: 'M2 read tools' }))
    const fact = value(await execute('sapper_fact', { action: 'create', description: 'Tomcat on localhost', title: 'Tomcat 服务', doc: 'DOC-NOT-IN-RECALL' }))
    setMode('read-only')
    const recalled = value(await execute('sapper_recall', { query: 'tomcat' }))
    expect(recalled.matches[0]).toMatchObject({ id: fact.id, has_doc: true })
    expect(JSON.stringify(recalled)).not.toContain('DOC-NOT-IN-RECALL')
    expect(value(await execute('sapper_kb', { action: 'search', query: 'Web 信息收集' })).matches[0].id).toBe('kb001')
    expect(value(await execute('sapper_kb', { action: 'get', id: 'kb001' })).entry.commands.length).toBeGreaterThan(0)
    expect(value(await execute('sapper_kb', { action: 'list', limit: 1 })).entries).toHaveLength(1)
    expect((await execute('sapper_recall', { query: 'tomcat', limit: 50 })).isError).toBe(true)
    expect((await execute('sapper_kb', { action: 'get', id: '../package' })).isError).toBe(true)
    setConfig({ kb: { enabled: false } })
    expect(value(await execute('sapper_kb', { action: 'search', query: 'web' }))).toMatchObject({ enabled: false, entries: [] })
    expect(request).not.toHaveBeenCalled()
  })
  it('does not require an approval provider for routine writes under a writable session policy', async () => {
    const { ctx, execute } = await setup()
    ctx.set('approval', undefined)
    expect(value(await execute('sapper_init', { goal: 'automatic local graph' })).goal).toBe('automatic local graph')
  })
  it('denies all writes in a read-only session before requesting approval, while keeping status readable', async () => {
    const { execute, request, cwd } = await setup('allowed-once', 'session', 'read-only')
    const result = await execute('sapper_init', { goal: 'must not write' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('只读')
    expect(value(await execute('sapper_status', {}))).toMatchObject({ state: 'uninitialized' })
    expect(await readdir(cwd)).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
  it('fails closed on missing file policy without breaking readonly status', async () => {
    const { disposePolicy, execute, cwd } = await setup()
    await disposePolicy()
    expect((await execute('sapper_init', { goal: 'must not write' })).isError).toBe(true)
    expect(value(await execute('sapper_status', {}))).toMatchObject({ state: 'uninitialized' })
    expect(await readdir(cwd)).toEqual([])
  })
  it('rechecks session permission after the pre-execute gate and before disk writes', async () => {
    const { ctx, setMode, execute, cwd } = await setup()
    ctx.on('tools/execute', async (_exec, next) => { setMode('read-only'); return next() })
    expect((await execute('sapper_init', { goal: 'revoked permission' })).isError).toBe(true)
    expect(await readdir(cwd)).toEqual([])
  })
  it('blocks a queued manual approval if session write permissions were revoked while waiting', async () => {
    const { setMode, execute, request, cwd } = await setup('allowed-once', 'always')
    request.mockImplementationOnce(async () => { setMode('read-only'); return 'allowed-once' })
    expect((await execute('sapper_init', { goal: 'revoked permission' })).isError).toBe(true)
    expect(await readdir(cwd)).toEqual([])
  })
  it('keeps deliberately confirmation-required intents blocked when their approval is rejected', async () => {
    const { execute, request } = await setup('rejected')
    value(await execute('sapper_init', { goal: 'explicit decision' }))
    const fact = value(await execute('sapper_fact', { action: 'create', description: 'seed' }))
    const intent = value(await execute('sapper_intent', { action: 'create', from: [fact.id], description: 'requires human', requires_confirmation: true }))
    expect((await execute('sapper_intent', { action: 'confirm', id: intent.id })).isError).toBe(true)
    expect((await execute('sapper_intent', { action: 'get', id: intent.id })).isError).toBe(false)
    expect(value(await execute('sapper_intent', { action: 'get', id: intent.id }))).toMatchObject({ confirmed_at: null, worker: null, status: 'open' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each([
    { enabled: false }, { store: { dir: 'changed-store' } }, { goal: 'changed goal' },
  ])('blocks a previously approved call if its configuration changes while awaiting approval: %j', async input => {
    const { execute, request, setConfig, cwd } = await setup('allowed-once', 'always')
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
