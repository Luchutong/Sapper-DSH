import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRuntime } from '../src/dsh-adapter/host.js'
import { resolveConfig } from '../src/settings.js'
import type { ConfigInput } from '../src/settings.js'
import type { RunRecord } from '../src/store/runs.js'
import { GraphStore } from '../src/store/graph.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
interface Scenario { noEvidence?: boolean; forged?: boolean; reject?: boolean; noVerifyEvidence?: boolean; delay?: number; attack?: boolean; proposals?: number; emptyReason?: boolean; hang?: boolean; completesGoal?: boolean; denyGoal?: boolean }
class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(readonly scenario: Scenario) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const raw = JSON.stringify(options.messages)
    const role = raw.includes('# Sapper verify') ? 'verify' : raw.includes('# Sapper explore') ? 'explore' : 'reason'
    const tools = options.messages.filter(m => m.role === 'tool')
    if (this.scenario.hang && role === 'explore') {
      await new Promise<void>((_, reject) => { const stop = () => reject(options.signal?.reason); options.signal?.addEventListener('abort', stop, { once: true }); if (options.signal?.aborted) stop() })
      return
    }
    let name = 'structured_output', args: unknown
    if (role === 'reason') args = { intents: this.scenario.emptyReason ? [] : Array.from({ length: this.scenario.proposals ?? 1 }, (_, n) => ({ title: `Check fixture ${n}`, description: `Read local fixture ${n}`, from: ['f001'], success_criteria: 'Fixture content contains VERIFIED-LOCAL-7C42', completes_goal: !!this.scenario.completesGoal })) }
    else if (!tools.length && this.scenario.attack) { name = 'sapper_fact'; args = { action: 'create', description: 'BYPASS' } }
    else if (tools.length < (this.scenario.attack ? 2 : 1) && !(role === 'explore' && (this.scenario.noEvidence || this.scenario.forged))) { name = 'read'; args = { path: 'fixture.txt' } }
    else if (role === 'explore') args = { title: 'Fixture observation', description: 'Local fixture contains VERIFIED-LOCAL-7C42', kind: 'note', evidence: this.scenario.noEvidence ? [] : [{ call_id: this.scenario.forged ? 'invented' : '', excerpt: this.scenario.forged ? 'FAKE-OUTPUT' : 'VERIFIED-LOCAL-7C42' }] }
    else args = { goal_achieved: !!this.scenario.completesGoal && !this.scenario.denyGoal, verified: !this.scenario.reject, issues: this.scenario.reject ? 'REPRODUCTION-MISMATCH' : '', evidence: this.scenario.noVerifyEvidence || this.scenario.reject ? [] : [{ call_id: '', excerpt: 'VERIFIED-LOCAL-7C42' }] }
    yield { type: 'reasoning-delta', index: 1, text: role === 'explore' ? 'EXPLORER-PRIVATE-TRACE' : 'fixture reasoning' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId('fixture-' + this.requests.length), name, argumentsDelta: JSON.stringify(args) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
async function setup(scenario: Scenario = {}, input: ConfigInput = {}, commands = false, maxDepth = 1) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper M3 中文 '))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(path.join(cwd, 'fixture.txt'), 'VERIFIED-LOCAL-7C42\n')
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: cwd })
  const approval = vi.fn(async () => 'rejected'); ctx.provide('approval', { request: approval })
  const subagentsFiber = await ctx.plugin(SubagentRuntime, { maxDepth, maxActiveSubagents: 8 })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const model = new FixtureModel(scenario)
  ctx.llm.registerAdapter(['fixture'], model)
  const read = vi.fn(async () => { if (scenario.delay) await new Promise(r => setTimeout(r, scenario.delay)); return await readFile(path.join(cwd, 'fixture.txt'), 'utf8') })
  ctx.tools.register(defineTool({ name: 'read', description: 'Read local fixture', parameters: { path: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: read }))
  let config = resolveConfig({ ...input, orchestration: { maxExplore: 1, maxSteps: 1, ...input?.orchestration } })
  if (commands) await ctx.plugin(CommandRuntime)
  registerRuntime(ctx, () => config)
  const harness = await mountAgentLoopTestHarness(ctx)
  const parent = await harness.create(SessionId('m3-parent'), { provider: 'fixture', model: 'fixture-model' }, { cwd })
  let count = 0
  const execute = async (name: string, args: unknown, signal = new AbortController().signal) => {
    const result = await ctx.tools.execute({ name, arguments: args, agent: parent, callId: ToolCallId('parent-' + ++count), signal })
    if (result.isError) throw new Error(result.error.message)
    return result.value
  }
  await execute('sapper_init', { goal: 'Verify local fixture' })
  await execute('sapper_fact', { action: 'create', title: 'Fixture input', description: 'A local fixture.txt is available', doc: 'UNRELATED-GRAPH-DOC' })
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
    const { dispatch, ctx, parent, model } = await setup({ proposals: 3, delay: 25 }, { orchestration: { maxSteps: 3, maxExplore: 2, concurrency: 2, models: { reason: 'fixture:reason-route', explore: 'explore-route', verify: 'verify-route' } } })
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
    const { dispatch, store, ctx, parent } = await setup({}, { orchestration: { maxChildSteps: 1 } })
    const run = await dispatch()
    expect(run.outcomes[0]?.error).toContain('步数预算')
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
    const { dispatch, config, ctx, parent } = await setup({ hang: true })
    // Shorten only the test clock; the public schema requires whole minutes.
    Object.defineProperty(config.orchestration, 'timeoutMin', { value: 0.002 })
    const run = await dispatch()
    expect(run.outcomes[0]?.error).toContain('超时')
    expect(ctx.agents.list()).toEqual([parent])
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
  expect(result?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('confirmed') })
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
