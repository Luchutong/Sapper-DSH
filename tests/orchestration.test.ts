import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRuntime } from '../src/dsh-adapter/host.js'
import { resolveConfig } from '../src/settings.js'
import type { ConfigInput } from '../src/settings.js'
import type { RunRecord } from '../src/store/runs.js'
import { GraphStore } from '../src/store/graph.js'
import { TaskPanelService } from '../src/dsh-adapter/panel.js'
import { resolveSelectedStore } from '../src/store/tasks.js'
import { checkedEvidence } from '../src/orchestration/types.js'
import { dshComposer } from './fixtures/dsh-composer.js'
import type { CommandClaim } from '@deepseek-ai/dsh-client-ui-conversation/client'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
interface Scenario { exploreReads?: number; verifyReads?: number; recipe?: string; noEvidence?: boolean; forged?: boolean; reject?: boolean; noVerifyEvidence?: boolean; beforeRead?: (signal: AbortSignal) => Promise<void>; attack?: boolean; proposals?: number; emptyReason?: boolean; hang?: boolean; completesGoal?: boolean; denyGoal?: boolean; maxTokens?: 'reason' | 'explore' | 'verify' }
class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(readonly scenario: Scenario) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const raw = JSON.stringify(options.messages)
    const role = raw.includes('# Sapper verify') ? 'verify' : raw.includes('# Sapper explore') ? 'explore' : 'reason'
    const receipt = raw.match(/ev-[a-f0-9-]{36}/g)?.at(-1) ?? 'missing-receipt'
    const tools = options.messages.filter(m => m.role === 'tool')
    if (this.scenario.maxTokens === role) { yield { type: 'finish', reason: { kind: 'max-tokens' } }; return }
    if (this.scenario.hang && role === 'explore') {
      await new Promise<void>((_, reject) => { const stop = () => reject(options.signal?.reason); options.signal?.addEventListener('abort', stop, { once: true }); if (options.signal?.aborted) stop() })
      return
    }
    const requiredReads = role === 'verify' ? this.scenario.verifyReads ?? 1 : this.scenario.exploreReads ?? 1
    let name = 'structured_output', args: unknown
    if (role === 'reason') args = { intents: this.scenario.emptyReason ? [] : Array.from({ length: this.scenario.proposals ?? 1 }, (_, n) => ({ title: `Check fixture ${n}`, description: `Read local fixture ${n}`, from: ['f001'], success_criteria: 'Fixture content contains VERIFIED-LOCAL-7C42', completes_goal: !!this.scenario.completesGoal })) }
    else if (!tools.length && this.scenario.attack) { name = 'sapper_fact'; args = { action: 'create', description: 'BYPASS' } }
    else if (tools.length < (this.scenario.attack ? requiredReads + 1 : requiredReads) && !(role === 'explore' && (this.scenario.noEvidence || this.scenario.forged))) { name = 'read'; args = { path: requiredReads > 1 ? `fixture-${tools.length}.txt` : 'fixture.txt' } }
    else if (role === 'explore') args = { title: 'Fixture observation', description: 'Local fixture contains VERIFIED-LOCAL-7C42', kind: 'note', ...(this.scenario.recipe ? { reproduction: this.scenario.recipe } : {}), evidence: this.scenario.noEvidence ? [] : [{ receipt_id: this.scenario.forged ? 'invented' : receipt }] }
    else args = { goal_achieved: !!this.scenario.completesGoal && !this.scenario.denyGoal, verified: !this.scenario.reject, issues: this.scenario.reject ? 'REPRODUCTION-MISMATCH' : '', evidence: this.scenario.noVerifyEvidence || this.scenario.reject ? [] : [{ receipt_id: receipt }] }
    yield { type: 'reasoning-delta', index: 1, text: role === 'explore' ? 'EXPLORER-PRIVATE-TRACE' : 'fixture reasoning' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId('fixture-' + this.requests.length), name, argumentsDelta: JSON.stringify(args) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
async function setup(scenario: Scenario = {}, input: ConfigInput = {}, commands = false, maxDepth = 1, topology: 'global' | 'preset' | 'preset-ptc' = 'global', bootstrap = true) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper M3 中文 '))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(path.join(cwd, 'fixture.txt'), 'VERIFIED-LOCAL-7C42\n')
  for (let i = 0; i < Math.max(scenario.exploreReads ?? 0, scenario.verifyReads ?? 0); i++) await writeFile(path.join(cwd, `fixture-${i}.txt`), `VERIFIED-LOCAL-7C42 observation ${i}\n`)
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: cwd })
  const approval = vi.fn(async () => 'rejected'); ctx.provide('approval', { request: approval })
  const subagentsFiber = await ctx.plugin(SubagentRuntime, { maxDepth, maxActiveSubagents: 8 })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const model = new FixtureModel(scenario)
  ctx.llm.registerAdapter(['fixture'], model)
  const read = vi.fn(async (readArgs: unknown, exec: ToolRunContext) => { await scenario.beforeRead?.(exec.signal); return await readFile(path.join(cwd, (readArgs as { path: string }).path), 'utf8') })
  const readDefinition = defineTool({ name: 'read', description: 'Read local fixture', parameters: { path: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: read })
  if (topology === 'global') ctx.tools.register(readDefinition)
  else {
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresetRegistry, { default: 'fixture' })
    ctx.loader.builtins.fixtureTools = { inject: ['tools', 'systemPrompt'], apply(scoped: Context) {
      scoped.tools.register(readDefinition)
      if (topology === 'preset-ptc') scoped.tools.presentAs('ptc')
    } }
    await ctx.agentPresets.register({ id: 'fixture', plugins: [{ name: 'cordis:fixtureTools' }] })
  }
  let config = resolveConfig({ ...input, orchestration: { maxExplore: 1, maxSteps: 1, ...input?.orchestration } })
  if (commands) await ctx.plugin(CommandRuntime)
  registerRuntime(ctx, () => config)
  const harness = await mountAgentLoopTestHarness(ctx)
  const parent = topology === 'global' ? await harness.create(SessionId('m3-parent'), { provider: 'fixture', model: 'fixture-model' }, { cwd })
    : (await ctx.agents.create({ sessionId: SessionId('m3-parent'), agentOptions: { provider: 'fixture', model: 'fixture-model' }, meta: { cwd, agentPreset: 'fixture' }, setup: async childCtx => { await ctx.agentPresets.mount(childCtx, 'fixture'); if (topology === 'preset-ptc') childCtx.tools.presentAs('native') } })).agent
  let count = 0
  const execute = async (name: string, args: unknown, signal = new AbortController().signal) => {
    const result = await ctx.tools.execute({ name, arguments: args, agent: parent, callId: ToolCallId('parent-' + ++count), signal })
    if (result.isError) throw new Error(result.error.message)
    return result.value
  }
  if (bootstrap) {
  await execute('sapper_init', { goal: 'Verify local fixture' })
  await execute('sapper_fact', { action: 'create', title: 'Fixture input', description: 'A local fixture.txt is available', doc: 'UNRELATED-GRAPH-DOC' })
  }
  const dispatch = (mode = 'run', extra = {}, signal?: AbortSignal) => execute('sapper_dispatch', { mode, ...extra }, signal) as Promise<unknown> as Promise<RunRecord>
  const store = new GraphStore(path.join(cwd, '.sapper'), cwd)
  return { ctx, cwd, model, approval, read, parent, execute, dispatch, store, disposeSubagents: () => subagentsFiber.dispose(), setConfig: (next: ConfigInput) => { config = resolveConfig(next); ctx.emit('loader/volatile-update', []) }, config }
}

describe('M3 production AgentLoop + SubagentRuntime + ToolRuntime', () => {
  it('runs reason → explore → independent verify and atomically confirms an evidence-backed fact', async () => {
    const { dispatch, store, ctx, parent, approval, model } = await setup()
    const run = await dispatch()
    expect(run, JSON.stringify(run)).toMatchObject({ state: 'completed', steps: 1, explored: 1, outcomes: [{ state: 'confirmed', fact_id: 'f002' }] })
    const graph = await store.read()
    expect(graph.facts.find(f => f.id === 'f002')).toMatchObject({ verification_status: 'confirmed', source_intent: 'i001' })
    expect(graph.intents[0]).toMatchObject({ status: 'done', confirmation_source: 'dsh-full-access' })
    expect(graph.integrity).toEqual([])
    expect(approval).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([parent])
    const verifyRequests = model.requests.filter(r => JSON.stringify(r.messages).includes('# Sapper verify'))
    expect(verifyRequests.length).toBeGreaterThan(0)
    for (const r of verifyRequests) {
      expect(JSON.stringify(r.messages)).not.toContain('EXPLORER-PRIVATE-TRACE')
      expect(JSON.stringify(r.messages)).not.toContain('UNRELATED-GRAPH-DOC')
      expect(r.tools?.map(t => t.name)).not.toContain('sapper_fact')
    }
    expect((await store.readRun(run.id)).outcomes[0]?.candidate?.evidence[0]?.tool).toBe('read')
  })
})

describe('M3 evidence gates, budgets and cancellation', () => {
  it.each([
    [{ noEvidence: true }, '缺少实际工具证据'],
    [{ forged: true }, '本子会话已成功调用'],
    [{ reject: true }, 'REPRODUCTION-MISMATCH'],
    [{ noVerifyEvidence: true }, '缺少实际工具证据'],
  ] as const)('keeps failed attempts out of facts and recalls the failure: %j', async (scenario, expected) => {
    const { dispatch, store, execute, ctx, parent } = await setup(scenario)
    const run = await dispatch()
    expect(run).toMatchObject({ state: 'failed', outcomes: [{ state: 'failed', error: expect.stringContaining(expected) }] })
    const graph = await store.read()
    expect(graph.facts.filter(f => f.id !== 'goal')).toHaveLength(1)
    expect(graph.intents[0]).toMatchObject({ status: 'open', worker: null, to: null })
    expect(graph.hints[0]?.content).toContain(expected)
    const recall = await execute('sapper_recall', { query: expected })
    expect(JSON.stringify(recall)).toContain('i001')
    expect(ctx.agents.list()).toEqual([parent])
  })
  it('persists a candidate without a fact, prevents manual bypass, and verifies it in a later run', async () => {
    const { dispatch, store, execute } = await setup()
    const reason = await dispatch('reason')
    const node = reason.intent_ids[0]!
    const explored = await dispatch('explore', { intent_id: node })
    expect(explored.outcomes[0]?.state).toBe('pending-verification')
    expect((await store.read()).facts.filter(f => f.id !== 'goal')).toHaveLength(1)
    await expect(execute('sapper_fact', { action: 'create', source_intent: node, description: 'bypass' })).rejects.toThrow('M3')
    await expect(execute('sapper_intent', { action: 'conclude', id: node, to: 'goal' })).rejects.toThrow('M3')
    const verified = await dispatch('verify', { run_id: explored.id, intent_id: node })
    expect(verified.outcomes[0]?.state).toBe('confirmed')
    expect((await store.read()).integrity).toEqual([])
  })
  it('enforces maxVerify across repeated calls referencing the original candidate run', async () => {
    const { dispatch, store, model } = await setup({ reject: true })
    const reason = await dispatch('reason'), node = reason.intent_ids[0]!
    const explored = await dispatch('explore', { intent_id: node })
    await dispatch('verify', { run_id: explored.id, intent_id: node })
    await dispatch('verify', { run_id: explored.id, intent_id: node })
    const before = model.requests.length
    const blocked = await dispatch('verify', { run_id: explored.id, intent_id: node })
    expect(model.requests).toHaveLength(before)
    expect(blocked.outcomes[0]?.error).toContain('预算')
    expect((await store.read()).intents[0]?.verification_budget).toMatchObject({ attempts: 2 })
  })
  it('blocks child graph writes even when the model attempts them', async () => {
    const { dispatch, store, model } = await setup({ attack: true })
    const run = await dispatch()
    expect(run.outcomes[0]?.state).toBe('confirmed')
    expect((await store.read()).facts.some(f => f.description === 'BYPASS')).toBe(false)
    expect(model.requests.some(r => JSON.stringify(r.messages).includes('sapper_fact'))).toBe(true)
  })
  it('caps concurrent children and total exploration while applying per-role model selection', async () => {
    let arrivals = 0, release!: () => void
    const pair = new Promise<void>(resolve => { release = resolve })
    const beforeRead = async (signal: AbortSignal) => {
      if (++arrivals === 2) release()
      signal.throwIfAborted()
      let abort!: () => void
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
      try { await Promise.race([pair, cancelled]) } finally { signal.removeEventListener('abort', abort) }
    }
    const { dispatch, ctx, parent, model } = await setup({ proposals: 3, beforeRead }, { orchestration: { maxSteps: 3, maxExplore: 2, concurrency: 2, models: { reason: 'fixture:reason-route', explore: 'explore-route', verify: 'verify-route' } } })
    let active = 0, peak = 0
    ctx.on('subagent/start', () => { active++; peak = Math.max(peak, active) })
    ctx.on('subagent/end', () => { active-- })
    const run = await dispatch()
    expect(run.explored).toBe(2); expect(run.steps).toBe(2)
    expect(peak).toBe(2); expect(active).toBe(0)
    expect(new Set(model.requests.map(r => r.model))).toEqual(new Set(['reason-route', 'explore-route', 'verify-route']))
    expect(ctx.agents.list()).toEqual([parent])
  })
  it('stops a child at its step budget and leaves a retryable intent', async () => {
    const { dispatch, store, ctx, parent } = await setup({ attack: true }, { orchestration: { budgetMode: 'fixed', maxSteps: 4, maxExplore: 4, maxChildSteps: 2 } })
    const run = await dispatch()
    expect(run.outcomes[0]?.error, JSON.stringify(run)).toContain('步数预算')
    expect(run.stop_reason).toContain('步数预算')
    expect((await store.read()).intents[0]?.status).toBe('open')
    expect(ctx.agents.list()).toEqual([parent])
  })
  it('cancels and drains an already-published child through the caller signal', async () => {
    const { dispatch, model, store, ctx, parent } = await setup({ hang: true })
    const controller = new AbortController(), pending = dispatch('run', {}, controller.signal)
    await vi.waitFor(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
    controller.abort(new Error('fixture-cancelled'))
    await expect(pending).rejects.toThrow('aborted')
    await vi.waitFor(async () => expect((await store.readRun('r001')).state).toBe('cancelled'))
    expect((await store.read()).intents[0]?.worker).toBeNull()
    expect(ctx.agents.list()).toEqual([parent])
  })
  it('times out published children and does not leave them resident', async () => {
    const { dispatch, model, ctx, parent } = await setup({ hang: true }, { orchestration: { timeoutMin: 7 } })
    // Fire the registered deadline only after explore is published. A 120ms wall-clock
    // deadline races reason/preset startup on slower Windows workers.
    const realSetTimeout = globalThis.setTimeout, deadlines: Array<() => void> = []
    const clock = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 7 * 60000) deadlines.push(() => handler(...args))
      return realSetTimeout(handler, delay, ...args)
    }) as typeof setTimeout)
    try {
      const pending = dispatch()
      await vi.waitFor(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
      expect(deadlines).toHaveLength(2)
      deadlines[1]!()
      const run = await pending
      expect(run.outcomes[0]?.error).toContain('超时')
      expect(ctx.agents.list()).toEqual([parent])
    } finally { clock.mockRestore() }
  })
  it('fails preflight without modifying the graph when the provider is missing', async () => {
    const { disposeSubagents, dispatch, store } = await setup()
    await disposeSubagents()
    await expect(dispatch()).rejects.toThrow('spawn')
    expect((await store.read()).project.counters.run).toBe(0)
  })
})

describe('M3 completion and permission revocation', () => {
  it.each([false, true])('requires independent goal confirmation before project completion: denyGoal=%s', async denyGoal => {
    const { dispatch, store } = await setup({ completesGoal: true, denyGoal })
    await dispatch()
    const graph = await store.read()
    expect(graph.project.status).toBe(denyGoal ? 'active' : 'completed')
    expect(graph.intents.some(i => i.to === 'goal')).toBe(!denyGoal)
    expect(graph.integrity).toEqual([])
  })
  it('keeps full-access/always automatic while restricted dispatch approval and read-only denial stay effective', async () => {
    const { dispatch, store, parent, model, approval, execute } = await setup({}, { store: { approval: 'always' } })
    parent.session.append('sandbox/mode', { mode: 'read-only' })
    await expect(dispatch()).rejects.toThrow('只读')
    expect(model.requests).toHaveLength(0)
    expect((await store.read()).project.counters.run).toBe(0)
    expect(await execute('sapper_dispatch', { mode: 'status' })).toEqual([])
    parent.session.append('sandbox/mode', { mode: 'workspace-write' })
    await expect(dispatch()).rejects.toThrow('rejected')
    expect(approval).toHaveBeenCalledOnce()
    parent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect((await dispatch()).outcomes[0]?.state).toBe('confirmed')
    expect(approval).toHaveBeenCalledOnce()
  })
  it('drains on permission revocation, preserves the graph, and explicitly recovers the interrupted run later', async () => {
    const { dispatch, model, parent, ctx, store, execute } = await setup({ hang: true })
    const pending = dispatch().catch(error => error)
    await vi.waitFor(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
    parent.session.append('sandbox/mode', { mode: 'read-only' })
    await pending
    await vi.waitFor(() => expect(ctx.agents.list()).toEqual([parent]))
    expect((await store.readRun('r001')).state).toBe('running')
    parent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect(await execute('sapper_dispatch', { mode: 'recover', run_id: 'r001' })).toMatchObject({ state: 'cancelled' })
    expect((await store.read()).intents[0]?.worker).toBeNull()
    expect((await store.read()).facts.filter(f => f.id !== 'goal')).toHaveLength(1)
  })
  it('stops children on plugin disable and removes the dispatch tool', async () => {
    const { dispatch, model, ctx, parent, setConfig } = await setup({ hang: true })
    const pending = dispatch().catch(error => error)
    await vi.waitFor(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
    setConfig({ enabled: false })
    await pending
    await vi.waitFor(() => expect(ctx.agents.list()).toEqual([parent]))
    expect(ctx.tools.get('sapper_dispatch')).toBeUndefined()
  })
})


it('runs /sapper run and reads /sapper runs through real CommandRuntime and ToolRuntime', async () => {
  const { ctx, parent, store, approval } = await setup({}, {}, true)
  const result = await ctx.commands.execute(parent, '/sapper run', [], new AbortController().signal)
  expect(result?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('后台任务已受理') })
  await (ctx.get('sapperPanel') as TaskPanelService).whenIdle(parent.session.header.cwd!)
  expect((await store.read()).facts.some(f => f.verification_status === 'confirmed')).toBe(true)
  const listed = await ctx.commands.execute(parent, '/sapper runs', [], new AbortController().signal)
  expect(listed?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('r001') })
  expect(approval).not.toHaveBeenCalled()
})

it('respects the DSH delegation-depth cap instead of expanding it for a nested caller', async () => {
  const { dispatch, model, store } = await setup({}, {}, false, 0)
  const run = await dispatch()
  expect(run.state).toBe('failed')
  expect(run.stop_reason).toMatch(/depth|深度/i)
  expect(model.requests).toHaveLength(0)
  expect((await store.read()).facts.filter(f => f.id !== 'goal')).toHaveLength(1)
})


it('inherits preset-scoped file tools into fresh explore/verify sessions', async () => {
  const { dispatch, ctx, parent, model, read } = await setup({}, {}, false, 1, 'preset')
  expect(ctx.tools.get('read')).toBeUndefined()
  expect(ctx.tools.get('read', parent)).toBeDefined()
  const run = await dispatch()
  expect(run, JSON.stringify(run)).toMatchObject({ state: 'completed', outcomes: [{ state: 'confirmed' }] })
  expect(read).toHaveBeenCalledTimes(2)
  for (const request of model.requests.filter(r => !JSON.stringify(r.messages).includes('# Sapper reason'))) expect(request.tools?.map(t => t.name)).toContain('read')
})


it('keeps preset PTC presentation intact while M3 children use native evidence and structured tools', async () => {
  const { dispatch, ctx, parent, model, read } = await setup({}, {}, false, 1, 'preset-ptc')
  const preset = scopeParentOf(parent)
  expect(ctx.tools.get('run_code', preset)).toBeDefined()
  const run = await dispatch()
  expect(run, JSON.stringify(run)).toMatchObject({ state: 'completed', outcomes: [{ state: 'confirmed' }] })
  expect(read).toHaveBeenCalledTimes(2)
  expect(ctx.tools.get('run_code', preset)).toBeDefined()
  for (const request of model.requests) {
    expect(request.tools?.map(t => t.name)).toContain('structured_output')
    expect(request.tools?.map(t => t.name)).not.toContain('run_code')
  }
})

it('fails once on missing preset evidence tools, then retries the existing i002 without rebuilding the graph', async () => {
  const { dispatch, execute, setConfig, store, model, cwd } = await setup({}, { orchestration: { exploreTools: ['pwsh'] } }, false, 1, 'preset')
  const history = await execute('sapper_intent', { action: 'create', from: ['f001'], description: 'M2 history setup' }) as { id: string }
  await execute('sapper_fact', { action: 'create', description: 'M2 history result', source_intent: history.id })
  const failed = await dispatch()
  expect(failed.state).toBe('failed')
  expect(failed.stop_reason).toContain('SAPPER_M3_TOOL_UNAVAILABLE')
  expect(model.requests).toHaveLength(1)
  expect((await store.read()).intents.find(i => i.id === 'i002')).toMatchObject({ status: 'open', worker: null, to: null })
  const original = await readFile(path.join(cwd, '.sapper/runs/r001.json'), 'utf8')
  setConfig({ orchestration: { maxSteps: 1, maxExplore: 1 } })
  const before = model.requests.length
  const retried = await dispatch()
  expect(retried).toMatchObject({ id: 'r002', state: 'completed', outcomes: [{ intent_id: 'i002', state: 'confirmed' }] })
  expect(model.requests.slice(before).some(r => JSON.stringify(r.messages).includes('# Sapper reason'))).toBe(false)
  expect(retried.children?.filter(c => c.role !== 'reason').every(c => c.external_tools.includes('read'))).toBe(true)
  expect(await readFile(path.join(cwd, '.sapper/runs/r001.json'), 'utf8')).toBe(original)
})

it('rejects a verifier with no external tools before a verifier model request', async () => {
  const { dispatch, model, store } = await setup({}, { orchestration: { verifyTools: ['pwsh'] } }, false, 1, 'preset')
  const run = await dispatch()
  expect(run.stop_reason).toContain('SAPPER_M3_TOOL_UNAVAILABLE')
  expect(run.outcomes[0]?.candidate).toBeDefined()
  expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
  expect((await store.read()).facts.some(f => f.verification_status === 'confirmed')).toBe(false)
})

it.each(['reason', 'explore', 'verify'] as const)('stops the run on %s max-tokens without another reasoning cycle', async role => {
  const { dispatch, model, store } = await setup({ maxTokens: role }, { orchestration: { maxSteps: 4, maxExplore: 4, maxOutputTokens: 4096 } })
  const run = await dispatch()
  expect(run.state).toBe('failed')
  expect(run.stop_reason).toContain('max-tokens')
  expect(run.stop_reason).toContain('maxOutputTokens=4096')
  expect(model.requests.filter(r => JSON.stringify(r.messages).includes('# Sapper reason'))).toHaveLength(1)
  expect((await store.read()).facts.some(f => f.verification_status === 'confirmed')).toBe(false)
})

it('does not restore a preset tool explicitly denied in the parent session', async () => {
  const { dispatch, parent, ctx, model, read } = await setup({}, {}, false, 1, 'preset')
  parent.ctx.tools.restrict({ deny: ['read'] })
  expect(ctx.tools.get('read', parent)).toBeUndefined()
  const run = await dispatch()
  expect(run.stop_reason).toContain('SAPPER_M3_TOOL_UNAVAILABLE')
  expect(read).not.toHaveBeenCalled()
  expect(model.requests).toHaveLength(1)
})

// Desktop regression: CRLF and Windows paths never pass through model-authored excerpts.
it('uses server receipts for multiline Windows output and independently verifies it', async () => {
  const { cwd, dispatch, store } = await setup()
  await writeFile(path.join(cwd, 'fixture.txt'), 'Path: C:\\Users\\航\\sample.txt\r\nVERIFIED-LOCAL-7C42\r\nSHA256: ABCDEF1234\r\n')
  const run = await dispatch()
  expect(run.state, JSON.stringify(run)).toBe('completed')
  const saved = await store.readRun(run.id), outcome = saved.outcomes[0]!
  expect(outcome.candidate!.evidence[0]).toMatchObject({ receipt_id: expect.stringMatching(/^ev-/), tool: 'read', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(outcome.candidate!.evidence[0]!.excerpt).toContain('\r\n')
  expect(outcome.verification!.evidence[0]!.receipt_id).not.toBe(outcome.candidate!.evidence[0]!.receipt_id)
  expect(() => checkedEvidence([{ receipt_id: outcome.candidate!.evidence[0]!.receipt_id }], new Map())).toThrow('本子会话')
})
it('starts from a normal existing workspace via the panel, isolates later tasks and resumes the original graph', async () => {
  const { ctx, parent, cwd, config, store } = await setup({ completesGoal: true }, {}, false, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService
  expect(await service.targets()).toEqual([{ id: String(parent.id), cwd }])
  expect(await service.state(String(parent.id))).toMatchObject({ active: 'legacy', tasks: [], runs: [] })
  expect(await store.initialized()).toBe(false)
  await service.action(String(parent.id), { action: 'start', goal: 'Verify local fixture' })
  await service.whenIdle(cwd)
  const first = await service.state(String(parent.id))
  expect(first.job, JSON.stringify(first)).toMatchObject({ state: 'completed' })
  expect(first.graph).toMatchObject({ status: 'completed', verified: 1, integrity: [] })
  const root = await resolveSelectedStore(cwd, config)
  const original = await new GraphStore(root!, cwd).read()
  expect(original.facts.find(f => f.id === 'f001')?.description).toContain(cwd)
  expect(original.facts.find(f => f.id === 'f001')?.verification_status).toBeUndefined()
  await service.action(String(parent.id), { action: 'start', goal: 'Second independent task' })
  await service.whenIdle(cwd)
  const second = await service.state(String(parent.id))
  expect(second.active).not.toBe(first.active)
  expect(second.tasks).toHaveLength(2)
  expect(await new GraphStore(root!, cwd).read()).toEqual(original)
  expect(await store.initialized()).toBe(false)
  // Completed tasks remain readable; continuing one reports completion instead of overwriting it.
  await service.action(String(parent.id), { action: 'resume', task_id: first.active })
  await service.whenIdle(cwd)
  expect((await service.state(String(parent.id))).active).toBe(first.active)
})
it('cancels panel background work and retains a ready intent for retry', async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const { ctx, parent, cwd } = await setup({ beforeRead: async signal => {
    entered(); await new Promise<void>((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  } }, {}, false, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService
  await service.action(String(parent.id), { action: 'start', goal: 'Verify local fixture' })
  await started
  await service.action(String(parent.id), { action: 'cancel' })
  await service.whenIdle(cwd)
  expect(await service.state(String(parent.id))).toMatchObject({ job: { state: 'cancelled' }, graph: { verified: 0, ready: 1 }, runs: [{ state: 'cancelled' }] })
  expect(ctx.agents.list()).toEqual([parent])
})

it('drives the task panel through actual client and host Typert Gateways with strict wire schemas', async () => {
  const { default: Registry } = await import('@deepseek-ai/dsh-typert-registry')
  const { default: Gateway } = await import('@deepseek-ai/dsh-api-gateway')
  const { RemoteAccessService } = await import('@deepseek-ai/dsh-api-remote-access')
  const ClientGateway = await import('@deepseek-ai/dsh-api-gateway/client')
  const { PANEL_REMOTE } = await import('../src/panel/rpc.js')
  const { ctx, parent, cwd } = await setup({ completesGoal: true }, {}, false, 1, 'preset', false)
  await ctx.plugin(Registry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(Gateway, {})
  const peerCtx = ctx.extend(), controller = new AbortController()
  const peer = { id: 'panel-owner' as import('@deepseek-ai/dsh-typert-protocol').PeerId, ctx: peerCtx, principal: { kind: 'owner' as const }, signal: controller.signal, interactions: 'none' as const, dispose: async () => {} }
  const client = new Context(); cleanup.push(() => client.fiber.dispose())
  await client.plugin(Registry)
  client.provide('connection', {
    interactions: 'none', isLoopback: true, generation: { getSnapshot: () => undefined },
    rpc: { open: () => { throw new Error('No streams expected') }, call: async (_path: string, endpoint: string, payload: { args: Record<string, unknown> }) => {
      const [namespace, method] = endpoint.split('/')
      return { ok: true, value: await ctx.typertGateway.invoke({ namespace: namespace!, method: method!, args: payload.args, peer }) }
    } },
  } as never)
  await client.plugin(ClientGateway)
  const { connectPanel } = await import('../src/client/connection.js')
  let connection!: ReturnType<typeof connectPanel>, wrongScope!: () => unknown
  const consumer = await client.plugin({ name: 'sapper-scoped-consumer', inject: ['remote'], apply(scoped: Context) {
    wrongScope = () => PANEL_REMOTE.methods['sapperPanel/targets']!.invoke(scoped.remote, {})
    connection = connectPanel(scoped as unknown as import('../src/dsh-adapter/client.js').BrowserContext)
  } })
  await vi.waitFor(() => expect(connection.getSnapshot().api, connection.getSnapshot().error).toBeDefined())
  expect(wrongScope).toThrow(/without inject/)
  const invoke = async (method: string, args: { sessionId?: string; input?: import('../src/panel/rpc.js').PanelAction }) => {
    const api = connection.getSnapshot().api!
    if (method === 'targets') return api.targets()
    if (method === 'state') return api.state(args.sessionId!)
    if (method === 'report') return api.report!(args.sessionId!)
    return api.action(args.sessionId!, args.input!)
  }
  expect(await invoke('targets', {})).toEqual([{ id: String(parent.id), cwd }])
  expect(await invoke('state', { sessionId: String(parent.id) })).toMatchObject({ tasks: [], runs: [] })
  const panelResults: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (session, event) => { if (session === parent.session && event.type === 'sapper/result') panelResults.push(event.data) })
  await invoke('action', { sessionId: String(parent.id), input: { action: 'start', goal: 'Verify local fixture' } })
  await (ctx.get('sapperPanel') as TaskPanelService).whenIdle(cwd)
  expect(await invoke('state', { sessionId: String(parent.id) })).toMatchObject({ job: { state: 'completed', result: { stop_reason: 'goal-completed' } }, graph: { status: 'completed', verified: 1 } })
  await expect(ctx.typertGateway.invoke({ namespace: 'sapperPanel', method: 'action', args: { sessionId: String(parent.id), input: { action: 'start', cwd: '/forged' } }, peer })).rejects.toThrow()
  if (process.env.SAPPER_BROWSER_PROBE === '1') {
    const { chromium } = await import('playwright-core')
    const { createServer } = await import('node:http')
    const { createRequire } = await import('node:module')
    const { mkdir } = await import('node:fs/promises')
    const require = createRequire(import.meta.url)
    const files: Record<string, string> = {
      '/react.js': path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'),
      '/react-dom.js': path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'),
      '/plugin.js': path.resolve('lib/client.js'),
    }
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Sapper panel integration</title>
      <style>:root{--dsw-alias-bg-base:#181a20;--dsw-alias-label-primary:#e5e7eb}body{font:15px system-ui,sans-serif;background:#181a20;color:#e5e7eb;margin:0;padding:30px}#app{max-width:950px;margin:auto}button,select{font:inherit;color:inherit;background:#2a303c;border:1px solid #657087;border-radius:6px;padding:7px 12px;cursor:pointer}button:disabled{opacity:.45;cursor:default}summary{padding:8px 0}p{line-height:1.6}textarea{font:inherit}h3{font-size:23px}</style>
      <div id="app"></div><div id="results" style="max-width:950px;margin:auto;padding-bottom:100px"></div><div id="composer" style="position:fixed;bottom:0;left:0;right:0;height:48px;overflow:hidden;background:#303744;padding:8px;box-sizing:border-box;transform:translateZ(0)"></div><script src="/react.js"></script><script src="/react-dom.js"></script>
      <script>window.__ModuleLoader__={load(entry){window.sapper=entry.factory(id=>id==='react'?React:id==='react-dom'?ReactDOM:{Fragment:React.Fragment,jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key})})}};</script><script src="/plugin.js"></script>
      <script>
      const remote={$mount:async contribution=>{for(const d of contribution.descriptors){remote[d.namespace]??={};remote[d.namespace][d.method]=async(...values)=>{const args=Object.fromEntries(d.parameters.map((p,i)=>[p.wire,values[i]]));return fetch('/rpc/'+d.namespace+'/'+d.method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)}).then(r=>r.json())}}return()=>{}}};
      const snapshot={status:'ready',writable:true,value:{enabled:true},base:{},user:{},revision:0};
      const scope={getSnapshot:()=>snapshot,subscribe:()=>()=>{},set:async()=>true,mutate:async()=>true};
      let ResultNode, definition;const resultRoot=ReactDOM.createRoot(document.getElementById('results'));
      sapper.apply({remote,inject:(_services,setup)=>setup({remote,effect:setup=>setup()}),uiConversation:{events:{register:d=>{definition=d;return()=>{}}}},configForms:{get:()=>scope,whileServed:(ids,setup)=>setup(new Set(ids))},effect:setup=>setup(),slots:{inject:(_name,setup)=>setup(),register:(options,Component)=>{if(options.name==='settings.section')ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(Component));if(options.name==='conversation.input.left')ReactDOM.createRoot(document.getElementById('composer')).render(React.createElement(Component,{sessionId:"${String(parent.id)}"}));if(options.name==='conversation.chat.node'&&options.key==='sapper-result')ResultNode=Component;return()=>{}}}});
      async function results(){const data=await fetch('/results').then(r=>r.json());if(ResultNode&&definition)resultRoot.render(data.map((value,i)=>{const event={type:'sapper/result',data:value,seq:i+1};const match=definition.match['sapper/result'](event);const context={key:'sapper-result:'+match.id,id:match.id,state:definition.start({}, {event}),matches:[{event}]};return React.createElement(ResultNode,{key:context.key,node:definition.buildViewNode(context)})}));}setInterval(results,300);results();
      </script></html>`
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/results') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(panelResults)); return }
        if (files[req.url!]) { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(await readFile(files[req.url!]!)); return }
        if (req.method === 'POST' && req.url?.startsWith('/rpc/')) {
          let body = ''; for await (const chunk of req) body += chunk
          const [, , namespace, method] = req.url.split('/')
          try { const value = await ctx.typertGateway.invoke({ namespace: namespace!, method: method!, args: JSON.parse(body), peer }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, value })) }
          catch (e) { res.end(JSON.stringify({ ok: false, error: { message: (e as Error).message } })) }
          return
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html)
      } catch (e) { res.statusCode = 500; res.end(String(e)) }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1250, height: 1000 } }), errors: string[] = []
      page.setDefaultTimeout(5000)
      page.on('pageerror', e => { errors.push(e.message); void writeFile('dist/validation/panel-browser-errors.json', JSON.stringify(errors)) })
      const port = (server.address() as import('node:net').AddressInfo).port
      await page.goto('http://127.0.0.1:' + port)
      await writeFile('dist/validation/panel-dom-before.html', await page.content())
      await page.screenshot({ path: 'dist/validation/panel-before.png' })
      await page.getByLabel('任务目标', { exact: true }).fill('Verify local fixture from an ordinary workspace')
      await page.getByRole('button', { name: '发起任务', exact: true }).click()
      await expect.poll(async () => (await serviceState()).tasks.length, { timeout: 10000 }).toBe(2)
      await (ctx.get('sapperPanel') as TaskPanelService).whenIdle(cwd)
      await expect.poll(async () => await page.locator('strong').filter({ hasText: 'Verify local fixture from an ordinary workspace' }).count(), { timeout: 10000 }).toBe(1)
      await expect.poll(async () => await page.locator('span[role=status]').textContent(), { timeout: 10000 }).toBe('已结束')
      await expect.poll(async () => await page.getByText('工作区任务（2）', { exact: true }).count(), { timeout: 10000 }).toBe(1)
      expect(errors).toEqual([])
      await mkdir('dist/validation', { recursive: true })
      await page.screenshot({ path: 'dist/validation/panel-desktop.png', fullPage: true })
      expect(await page.getByRole('option').filter({ hasText: cwd }).count()).toBe(1)
      await page.getByRole('button', { name: '打开 Sapper 任务', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Sapper 任务窗口' })
      await dialog.waitFor({ state: 'visible' })
      await dialog.getByRole('button', { name: '事实图', exact: true }).click()
      await dialog.locator('svg').waitFor({ state: 'visible' })
      const bounds = await dialog.boundingBox()
      expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 1000).toBe(true)
      await page.screenshot({ path: 'dist/validation/panel-dialog.png' })
      await dialog.getByRole('button', { name: '结果与候选', exact: true }).click()
      await dialog.getByRole('article', { name: 'Sapper 任务结果' }).waitFor()
      await dialog.getByRole('button', { name: '发送结果到主会话' }).click()
      await expect.poll(async () => panelResults.length).toBe(3)
      await expect.poll(async () => page.locator('#results article').count()).toBe(3)
      expect(await page.locator('#results').textContent()).toContain('已独立复核')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      expect(await page.getByRole('button', { name: '打开 Sapper 任务' }).evaluate(el => el === document.activeElement)).toBe(true)
      await page.locator('#results').scrollIntoViewIfNeeded()
      await page.screenshot({ path: 'dist/validation/panel-results.png', fullPage: true })
      expect(errors).toEqual([])

      await writeFile('dist/validation/panel-browser.json', JSON.stringify({ errors, state: await serviceState() }, null, 2))
      async function serviceState() { return (ctx.get('sapperPanel') as TaskPanelService).state(String(parent.id)) }
    } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
  await consumer.dispose()
}, process.env.SAPPER_BROWSER_PROBE === '1' ? 45000 : 5000)

it('resumes a failed legacy workspace graph through the panel without recreating facts or rerunning reason', async () => {
  const scenario = { forged: true, completesGoal: true }
  const { ctx, cwd, parent, dispatch, store, model } = await setup(scenario)
  const first = await dispatch()
  expect(first.state).toBe('failed')
  const saved = await store.readRun(first.id), before = model.requests.length
  scenario.forged = false
  const service = ctx.get('sapperPanel') as TaskPanelService
  await service.action(String(parent.id), { action: 'resume', task_id: 'legacy' })
  await service.whenIdle(cwd)
  expect(await service.state(String(parent.id))).toMatchObject({ active: 'legacy', job: { state: 'completed' }, graph: { status: 'completed', verified: 1 } })
  expect(await store.readRun(first.id)).toEqual(saved)
  expect((await store.read()).facts.find(f => f.id === 'f001')?.description).toBe('A local fixture.txt is available')
  expect(model.requests.slice(before).some(r => !JSON.stringify(r.messages).includes('# Sapper explore') && !JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
})
it('keeps read-only panel starts out of the filesystem and reports the actual policy refusal', async () => {
  const { ctx, cwd, parent, store } = await setup({}, {}, false, 1, 'preset', false)
  parent.session.append('sandbox/mode', { mode: 'read-only' })
  const service = ctx.get('sapperPanel') as TaskPanelService
  await service.action(String(parent.id), { action: 'start', goal: 'Verify local fixture' })
  await service.whenIdle(cwd)
  const state = await service.state(String(parent.id))
  expect(state.job).toMatchObject({ state: 'failed', error: expect.stringContaining('只读') })
  expect(state.tasks).toEqual([])
  expect(await store.initialized()).toBe(false)
  await expect(readFile(path.join(cwd, '.sapper', 'tasks', 'index.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('starts and monitors a fresh task beside an unreadable legacy M0 graph without overwriting it', async () => {
  const { ctx, cwd, parent } = await setup({ completesGoal: true }, {}, false, 1, 'preset', false)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path.join(cwd, '.sapper'))
  const legacy = path.join(cwd, '.sapper', 'project.json'), original = JSON.stringify({ goal: 'Old M0 preview', status: 'active' })
  await writeFile(legacy, original)
  const service = ctx.get('sapperPanel') as TaskPanelService
  expect((await service.state(String(parent.id))).warnings?.join(' ')).toContain('无法读取')
  await service.action(String(parent.id), { action: 'start', goal: 'Verify local fixture' })
  await service.whenIdle(cwd)
  expect(await service.state(String(parent.id))).toMatchObject({ job: { state: 'completed' }, graph: { status: 'completed', verified: 1 }, warnings: expect.any(Array) })
  expect(await readFile(legacy, 'utf8')).toBe(original)
})

it('acknowledges slash start before a blocked child finishes, keeps the session usable and cancels from commands', async () => {
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const { ctx, parent, cwd } = await setup({ beforeRead: async signal => {
    entered()
    await new Promise<void>((_, reject) => { const stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop() })
  } }, {}, true, 1, 'preset', false)
  const commandEvents: string[] = []
  ctx.on('session/event', (session, event) => { if (session === parent.session && (event.type === 'command/run' || event.type === 'command/done')) commandEvents.push(event.type) })
  const composer = await dshComposer(), transport = new AbortController()
  const claim: CommandClaim = { name: 'sapper', token: '/sapper ', submit: async args => {
    const result = await ctx.commands.execute(parent, '/sapper ' + args, [], transport.signal)
    return result!.result
  } }
  const [adjudication] = composer.dispatch({ type: 'enter', mode: 'queue', draft: '/sapper start Verify local fixture' })
  expect(composer.state.phase).toBe('adjudicating')
  const [submission] = composer.dispatch({ type: 'adjudicated', attempt: adjudication!.attempt, outcome: { claim } })
  expect(composer.state.phase).toBe('submitting')
  const accepted = await submission!.claim.submit(submission!.args, ctx, [])
  expect(accepted).toMatchObject({ kind: 'success', text: expect.stringContaining('后台任务已受理') })
  const effects = composer.dispatch({ type: 'submit-settled', attempt: submission!.attempt, ok: accepted.kind === 'success', command: undefined, outcome: accepted })
  expect(composer.state.phase).toBe('plain') // DSH InputBar derives editability from this actual SDK state.
  expect(effects.some(effect => effect.type === 'commit-draft')).toBe(true)
  // Disposing the completed command request must not abort the background child.
  composer.dispatch({ type: 'release' })
  transport.abort(new Error('completed composer request released'))
  await reading
  const service = ctx.get('sapperPanel') as TaskPanelService
  expect(await service.state(String(parent.id))).toMatchObject({ job: { state: 'running' }, graph: { verified: 0 } })
  expect(commandEvents).toEqual(['command/run', 'command/done'])
  expect((await ctx.commands.execute(parent, '/sapper job', [], new AbortController().signal))?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('running') })
  expect((await ctx.commands.execute(parent, '/sapper status', [], new AbortController().signal))?.result.kind).toBe('success')
  expect((await ctx.commands.execute(parent, '/sapper start Duplicate task', [], new AbortController().signal))?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('已有任务') })
  expect((await ctx.commands.execute(parent, '/sapper cancel', [], new AbortController().signal))?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('已请求取消') })
  await service.whenIdle(cwd)
  expect(await service.state(String(parent.id))).toMatchObject({ job: { state: 'cancelled' }, graph: { ready: 1, verified: 0 }, runs: [{ state: 'cancelled' }] })
  expect(ctx.agents.list()).toEqual([parent])
})
it('reports failed background command admission and permits a later retry without creating another graph', async () => {
  const { ctx, parent, cwd, store } = await setup({}, {}, true, 1, 'preset', false)
  parent.session.append('sandbox/mode', { mode: 'read-only' })
  const service = ctx.get('sapperPanel') as TaskPanelService
  const command = await ctx.commands.execute(parent, '/sapper start Verify local fixture', [], new AbortController().signal)
  expect(command?.result.kind).toBe('success')
  await service.whenIdle(cwd)
  expect(await service.state(String(parent.id))).toMatchObject({ job: { state: 'failed', error: expect.stringContaining('只读') }, tasks: [] })
  expect(await store.initialized()).toBe(false)
  parent.session.append('sandbox/mode', { mode: 'danger-full-access' })
  await ctx.commands.execute(parent, '/sapper start Verify local fixture', [], new AbortController().signal)
  await service.whenIdle(cwd)
  expect(await service.state(String(parent.id))).toMatchObject({ job: { state: 'completed' }, tasks: [expect.any(Object)], graph: { verified: 1 } })
})

it('extends a productive verifier past the old 12-step limit and carries a minimal reproduction recipe', async () => {
  const { dispatch, store, model } = await setup({ verifyReads: 12, recipe: 'Read fixture-0.txt through fixture-11.txt independently; each must contain VERIFIED-LOCAL-7C42.' }, { orchestration: { maxChildSteps: 12, budgetMode: 'adaptive', maxChildStepsCeiling: 36 } })
  const run = await dispatch()
  expect(run.state, JSON.stringify(run)).toBe('completed')
  expect(run.outcomes[0]?.state).toBe('confirmed')
  const child = run.children?.find(c => c.role === 'verify')!
  expect(child.steps).toBe(13)
  expect(child.extensions).toBeGreaterThan(0)
  expect(child.step_limit).toBeGreaterThan(12)
  expect(child.state).toBe('completed')
  expect((await store.read()).facts.some(f => f.verification_status === 'confirmed')).toBe(true)
  expect(model.requests.filter(r => JSON.stringify(r.messages).includes('# Sapper verify')).every(r => JSON.stringify(r.messages).includes('Read fixture-0.txt'))).toBe(true)
})
it('reserves a structured-output round under a fixed budget and keeps external tools out of finalization', async () => {
  const { dispatch, model, read } = await setup({}, { orchestration: { budgetMode: 'fixed', maxChildSteps: 2 } })
  const run = await dispatch()
  expect(run.state, JSON.stringify(run)).toBe('completed')
  const finals = model.requests.filter(r => JSON.stringify(r.messages).includes('Sapper finalization'))
  expect(finals).toHaveLength(2)
  for (const r of finals) {
    expect(r.tools?.map(t => t.name)).toContain('structured_output')
  }
  expect(read).toHaveBeenCalledTimes(2)
})
it('resumes a saved candidate with a fresh verifier instead of repeating exploration', async () => {
  const scenario: Scenario = { maxTokens: 'verify' }
  const { dispatch, store } = await setup(scenario)
  const first = await dispatch()
  const candidate = first.outcomes[0]?.candidate
  expect(candidate).toBeDefined()
  expect(first.state).toBe('failed')
  const originalRun = await store.readRun(first.id)
  delete scenario.maxTokens
  const second = await dispatch()
  expect(second).toMatchObject({ state: 'completed', explored: 0, outcomes: [{ state: 'confirmed', verify_attempts: 2 }] })
  expect(second.children?.map(c => c.role)).toEqual(['verify'])
  expect(second.outcomes[0]?.candidate?.explorer_session).toBe(candidate?.explorer_session)
  expect(await store.readRun(first.id)).toEqual(originalRun)
})
it('publishes confirmed results and incomplete candidates back to the originating main session without starting a parent turn', async () => {
  const scenario: Scenario = { maxTokens: 'verify' }
  const { ctx, cwd, parent } = await setup(scenario, {}, true, 1, 'preset', false)
  const results: import('../src/panel/result.js').TaskResult[] = []
  const parentTurns: string[] = []
  ctx.on('session/event', (session, event) => {
    if (session !== parent.session) return
    if (event.type === 'sapper/result') results.push(event.data)
    if (event.type === 'turn/start') parentTurns.push(event.type)
  })
  const service = ctx.get('sapperPanel') as TaskPanelService
  await ctx.commands.execute(parent, '/sapper start Verify local fixture', [], new AbortController().signal)
  await service.whenIdle(cwd)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ state: 'failed', confirmed: [], candidates: [{ status: 'unverified', description: expect.stringContaining('VERIFIED-LOCAL-7C42') }] })
  delete scenario.maxTokens
  await ctx.commands.execute(parent, '/sapper run', [], new AbortController().signal)
  await service.whenIdle(cwd)
  expect(results).toHaveLength(2)
  expect(results[1]).toMatchObject({ state: 'completed', confirmed: [{ id: 'f002' }], candidates: [] })
  expect(parentTurns).toEqual([])
  const report = await ctx.commands.execute(parent, '/sapper result', [], new AbortController().signal)
  expect(report?.result.kind).toBe('success')
  expect(results).toHaveLength(3)
})

it('denies extra evidence calls after entering finalization even when a model ignores the finish notice', async () => {
  const { dispatch, read } = await setup({ exploreReads: 4 }, { orchestration: { budgetMode: 'fixed', maxChildSteps: 3 } })
  const run = await dispatch()
  expect(run.state).toBe('failed')
  expect(run.outcomes[0]?.error).toContain('步数预算')
  expect(read).toHaveBeenCalledTimes(1)
})
