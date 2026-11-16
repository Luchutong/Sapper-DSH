import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { LlmAdapter, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
import { resultOfEvent } from '../src/dsh-adapter/result-event.js'
import { checkedEvidence } from '../src/orchestration/types.js'
import { dshComposer } from './fixtures/dsh-composer.js'
import type { CommandClaim } from '@deepseek-ai/dsh-client-ui-conversation/client'

// Real SDK setup and durable multi-file writes are much slower on cold Windows CI disks.
// These are harness deadlines, independent of the runtime budgets tested below.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 })
const waitForRuntime: typeof vi.waitFor = (callback) =>
  vi.waitFor(callback, { timeout: 10000 })
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})
interface Scenario {
  resourceBindings?: boolean
  capabilitiesByRoute?: string[]
  resourceRequestAfterRead?: boolean
  externalName?: string
  verifyExternalName?: string
  registeredTools?: string[]
  parentEffort?: string
  summaryAttack?: boolean
  userRead?: boolean
  userGate?: Promise<void>
  writeup?: boolean
  flag?: string
  flagValues?: string[]
  reasonOnce?: boolean
  citeAll?: boolean
  hangOther?: boolean
  exploreReads?: number
  verifyReads?: number
  recipe?: string
  noEvidence?: boolean
  forged?: boolean
  reject?: boolean
  noVerifyEvidence?: boolean
  beforeRead?: (signal: AbortSignal) => Promise<void>
  attack?: boolean
  proposals?: number
  emptyReason?: boolean
  planningDiscovery?: boolean
  blockedReason?: string
  hang?: boolean
  completesGoal?: boolean
  denyGoal?: boolean
  maxTokens?: 'reason' | 'explore' | 'verify'
  verifyGate?: Promise<void>
}
class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  async listModels() {
    return [{ provider: 'fixture', id: 'fixture-model', name: 'Fixture model' }, { provider: 'fixture', id: 'fixture-other', name: 'Other fixture' }]
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: { efforts: (model === 'fixture-other' ? ['other-only'] : ['fixture-low', 'fixture-max']).map((id) => ({ id: ReasoningEffortId(id), name: id })) } }
  }
  constructor(readonly scenario: Scenario) {
    super()
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const raw = JSON.stringify(options.messages)
    if (this.scenario.userRead && raw.includes('USER_AFTER_BRIEF')) {
      if (!raw.includes('user-read')) {
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: ToolCallId('user-read'),
          name: 'read',
          argumentsDelta: JSON.stringify({ path: 'fixture.txt' }),
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: 'User read completed' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return
    }
    if (
      this.scenario.userGate &&
      raw.includes('USER_BUSY') &&
      !raw.includes('SAPPER_MAIN_BRIEF')
    ) {
      await this.scenario.userGate
      yield { type: 'text-delta', index: 0, text: 'User request completed' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (
      raw.includes('SAPPER_MAIN_BRIEF') &&
      !raw.includes('# Sapper reason') &&
      !raw.includes('# Sapper explore') &&
      !raw.includes('# Sapper verify')
    ) {
      if (this.scenario.summaryAttack) {
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: ToolCallId('brief-attack'),
          name: 'sapper_control',
          argumentsDelta: JSON.stringify({
            action: 'continue',
            goal: 'FORBIDDEN BRIEF RUN',
          }),
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield {
        type: 'text-delta',
        index: 0,
        text: '本轮已结束。证据与 flag 验证状态已保存在任务详情中；可继续复核或编写 WP.md。',
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const role = raw.includes('# Sapper verify') ? 'verify' : raw.includes('# Sapper explore') ? 'explore' : 'reason'
    if (role === 'verify') await this.scenario.verifyGate
    const receipt = raw.match(/ev-[a-f0-9-]{36}/g)?.at(-1) ?? 'missing-receipt'
    const route = Number(/Read local fixture (\d+)/.exec(raw)?.[1] ?? 0), flagValue = this.scenario.flagValues?.[route] ?? this.scenario.flag
    const tools = options.messages.filter((m) => m.role === 'tool')
    if (this.scenario.maxTokens === role) { yield { type: 'finish', reason: { kind: 'max-tokens' } }; return }
    if ((this.scenario.hang || (this.scenario.hangOther && raw.includes('Read local fixture 1'))) && role === 'explore') {
      await new Promise<void>((_, reject) => { const stop = () => reject(options.signal?.reason); options.signal?.addEventListener('abort', stop, { once: true }); if (options.signal?.aborted) stop() })
      return
    }
    const requiredReads = role === 'verify' ? this.scenario.verifyReads ?? 1 : this.scenario.exploreReads ?? 1
    let name = 'structured_output',
      args: unknown
    if (role === 'reason' && this.scenario.planningDiscovery && tools.length < 2) { name = 'sapper_tools'; args = tools.length ? { action: 'status' } : { action: 'search', query: 'archive file read list extract rar' } }
    else if (role === 'reason') args = { ...(this.scenario.blockedReason ? { blocked_reason: this.scenario.blockedReason } : {}), intents: this.scenario.emptyReason || this.scenario.blockedReason || (this.scenario.reasonOnce && this.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper reason')).length > 1) ? [] : Array.from({ length: this.scenario.proposals ?? 1 }, (_, n) => ({ ...(this.scenario.capabilitiesByRoute?.[n] ? { tool_capabilities: [this.scenario.capabilitiesByRoute[n]] } : {}), title: `Check fixture ${n}`, description: `Read local fixture ${n}`, from: [this.scenario.planningDiscovery ? 'f002' : 'f001'], success_criteria: 'Fixture content contains VERIFIED-LOCAL-7C42', completes_goal: !!this.scenario.completesGoal })) }
    else if (role === 'explore' && route === 0 && tools.length === 1 && this.scenario.resourceRequestAfterRead) { name = 'sapper_resource'; args = { action: 'acquire', capabilities: ['binary.b'] } }
    else if (!tools.length && this.scenario.writeup) { name = role === 'explore' ? 'pwsh' : 'read'; args = role === 'explore' ? { code: 'write-local-wp' } : { path: 'WP.md' } }
    else if (!tools.length && this.scenario.attack) { name = 'sapper_fact'; args = { action: 'create', description: 'BYPASS' } }
    else if (tools.length < (this.scenario.attack ? requiredReads + 1 : requiredReads) && !(role === 'explore' && (this.scenario.noEvidence || this.scenario.forged))) { name = (role === 'verify' ? this.scenario.verifyExternalName : undefined) ?? this.scenario.externalName ?? 'read'; args = { path: this.scenario.flagValues ? `flag-${route}.txt` : requiredReads > 1 ? `fixture-${tools.length}.txt` : 'fixture.txt' } }
    else if (role === 'explore') args = { title: 'Fixture observation', description: this.scenario.writeup ? 'WP.md: local evidence and reproduction steps saved' : flagValue ?? 'Local fixture contains VERIFIED-LOCAL-7C42', kind: flagValue && !this.scenario.writeup ? 'flag' : 'note', goal_achieved: !!this.scenario.completesGoal, ...(this.scenario.recipe ? { reproduction: this.scenario.recipe } : {}), evidence: this.scenario.noEvidence ? [] : this.scenario.citeAll ? [...new Set(raw.match(/ev-[a-f0-9-]{36}/g) ?? [])].map((receipt_id) => ({ receipt_id })) : [{ receipt_id: this.scenario.forged ? 'invented' : receipt }] }
    else args = { goal_achieved: !!this.scenario.completesGoal && !this.scenario.denyGoal, verified: !this.scenario.reject, issues: this.scenario.reject ? 'REPRODUCTION-MISMATCH' : '', evidence: this.scenario.noVerifyEvidence || this.scenario.reject ? [] : [{ receipt_id: receipt }] }
    if (name === 'available-mcp') name = options.tools?.find((t) => t.name.startsWith('mcp__ida__slot'))?.name ?? name
    if (this.scenario.resourceBindings && name.startsWith('mcp__')) {
      for (const message of options.messages) if (Array.isArray(message.content)) for (const block of message.content) if (block.type === 'text' && block.text.startsWith('Sapper resource bindings (data): ')) {
        const hints = JSON.parse(block.text.slice('Sapper resource bindings (data): '.length)) as Array<{ bindings: Record<string, string> }>
        args = { ...(args as Record<string, unknown>), ...hints[0]?.bindings }
      }
    }
    yield { type: 'reasoning-delta', index: 1, text: role === 'explore' ? 'EXPLORER-PRIVATE-TRACE' : 'fixture reasoning' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId('fixture-' + this.requests.length), name, argumentsDelta: JSON.stringify(args) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
async function setup(
  scenario: Scenario = {},
  input: ConfigInput = {},
  commands = false,
  maxDepth = 1,
  topology: 'global' | 'preset' | 'preset-ptc' = 'global',
  bootstrap = true,
  capacity = 8,
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper M3 中文 '))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(
    path.join(cwd, 'fixture.txt'),
    (scenario.flag ?? 'VERIFIED-LOCAL-7C42') + '\n',
  )
  for (let i = 0; i < Math.max(scenario.exploreReads ?? 0, scenario.verifyReads ?? 0); i++) await writeFile(path.join(cwd, `fixture-${i}.txt`), `VERIFIED-LOCAL-7C42 observation ${i}\n`)
  for (const [i, value] of (scenario.flagValues ?? []).entries()) await writeFile(path.join(cwd, `flag-${i}.txt`), value + '\n')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SandboxPolicyService, {
    mode: 'danger-full-access',
    workspaceRoot: cwd,
  })
  const approval = vi.fn(async () => 'rejected')
  ctx.provide('approval', { request: approval })
  const subagentsFiber = await ctx.plugin(SubagentRuntime, {
    maxDepth,
    maxActiveSubagents: capacity,
  })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const model = new FixtureModel(scenario)
  ctx.llm.registerAdapter(['fixture'], model)
  const read = vi.fn(async (readArgs: unknown, exec: ToolRunContext) => {
    await scenario.beforeRead?.(exec.signal)
    return await readFile(
      path.join(
        exec.agent?.session.header.cwd ?? cwd,
        (readArgs as { path: string }).path,
      ),
      'utf8',
    )
  })
  const readDefinition = defineTool({ name: 'read', description: 'Read local fixture', parameters: { path: { type: 'string', required: true }, ...(scenario.resourceBindings ? { session_id: { type: 'string' as const } } : {}) }, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: read })
  const wpDefinition = defineTool({
    name: 'pwsh',
    description: 'Local fixture WP writer',
    parameters: { code: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    execute: async (_args, exec) => {
      await writeFile(
        path.join(exec.agent?.session.header.cwd ?? cwd, 'WP.md'),
        '# WP\nEvidence: VERIFIED-LOCAL-7C42\nReproduction: read the local fixture.\n',
      )
      return 'WP.md saved' + (scenario.writeup && scenario.flag ? '\n' + scenario.flag : '')
    },
  })
  if (topology === 'global') { ctx.tools.register(readDefinition); for (const name of scenario.registeredTools ?? []) ctx.tools.register({ ...readDefinition, name }); if ('writeup' in scenario) ctx.tools.register(wpDefinition) }
  else {
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresetRegistry, { default: 'fixture' })
    ctx.loader.builtins.fixtureTools = { inject: ['tools', 'systemPrompt'], apply(scoped: Context) {
      scoped.tools.register(readDefinition); for (const name of scenario.registeredTools ?? []) scoped.tools.register({ ...readDefinition, name }); if ('writeup' in scenario) scoped.tools.register(wpDefinition)
      if (topology === 'preset-ptc') scoped.tools.presentAs('ptc')
    } }
    await ctx.agentPresets.register({ id: 'fixture', plugins: [{ name: 'cordis:fixtureTools' }] })
  }
  let config = resolveConfig({ ...input, verification: { mode: 'independent', ...input?.verification }, orchestration: { maxExplore: 1, maxSteps: 1, ...input?.orchestration } })
  if (commands) await ctx.plugin(CommandRuntime)
  // Match the real Loader boundary: optional services cannot be accessed as
  // properties of this tools/agents scope, even when provided at the root.
  const built = process.env.SAPPER_PACKAGED_HOST === '1'
    ? await import(new URL('../lib/index.js', import.meta.url).href)
    : undefined
  await ctx.plugin({ name: 'sapper-runtime-fixture', inject: ['tools', 'agents'], apply(scoped: Context) {
    if (built) built.apply(scoped, { get: () => config })
    else registerRuntime(scoped, () => config)
  } })
  await mountAgentLoopTestHarness(ctx)
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId('m3-parent'),
    agentOptions: { provider: 'fixture', model: 'fixture-model', ...(scenario.parentEffort ? { reasoningEffort: ReasoningEffortId(scenario.parentEffort) } : {}) },
    meta: { cwd, ...(topology !== 'global' ? { agentPreset: 'fixture' } : {}) },
    ...(topology !== 'global'
      ? {
          setup: async (childCtx: Context) => {
            await ctx.agentPresets.mount(childCtx, 'fixture')
            if (topology === 'preset-ptc') childCtx.tools.presentAs('native')
          },
        }
      : {}),
  })
  const parent = parentHandle.agent

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
  return {
    ctx,
    cwd,
    model,
    approval,
    read,
    parent,
    disposeParent: parentHandle.dispose,
    execute,
    dispatch,
    store,
    disposeSubagents: () => subagentsFiber.dispose(),
    setConfig: (next: ConfigInput) => {
      config = resolveConfig({ ...next, verification: { mode: 'independent', ...next?.verification } })
      ctx.emit('loader/volatile-update', [])
    },
    config,
  }
}

describe('M3 production AgentLoop + SubagentRuntime + ToolRuntime', () => {
  it('plans attachment inspection with native tools even when no MCP is active and keeps the planner read-only', async () => {
    const { dispatch, execute, ctx, model, read, store } = await setup({ planningDiscovery: true, writeup: false }, { verification: { mode: 'none' } }, false, 1, 'preset-ptc')
    expect(await execute('sapper_tools', { action: 'search', query: 'file read archive' })).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'read', kind: 'native', executionRole: 'main' })]))
    await execute('sapper_fact', { action: 'create', title: '用户上传的题目附件', description: 'Attachment fixture.txt received; content has not been inspected.', doc: JSON.stringify({ source: 'user-upload', files: [{ path: 'fixture.txt' }] }) })
    const directories: unknown[] = []
    ctx.on('tools/result', (exec, result) => { if (exec.name === 'sapper_tools' && !result.isError) directories.push(result.value) })
    const run = await dispatch()
    expect(run, JSON.stringify(run)).toMatchObject({ state: 'completed', explored: 1, outcomes: [{ state: 'observed' }] })
    expect(read).toHaveBeenCalledOnce()
    expect(directories[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'read', kind: 'native', executionRole: 'explore' })]))
    expect(directories[1]).toMatchObject({ role: 'reason', catalogRole: 'explore', selected: [], availableTools: expect.arrayContaining([expect.objectContaining({ name: 'pwsh' }), expect.objectContaining({ name: 'read' })]) })
    for (const request of model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper reason'))) {
      expect(request.tools?.map((t) => t.name)).not.toContain('read')
      expect(request.tools?.map((t) => t.name)).not.toContain('pwsh')
      expect(JSON.stringify(request.messages)).toContain('execution_tools')
    }
    expect((await store.read()).intents[0]?.from).toEqual(['f002'])
  })

  it('filters the planning directory by parent authorization and explorer selectors without invoking MCP tools', async () => {
    const denied = 'mcp__ida__read', other = 'mcp__other__read'
    const { dispatch, ctx, parent, read } = await setup({ planningDiscovery: true, registeredTools: [denied, other], emptyReason: true, writeup: false }, { orchestration: { exploreTools: ['read', 'mcp__ida__*'] } }, false, 1, 'preset')
    parent.ctx.tools.restrict({ deny: [denied] })
    const directories: unknown[] = []
    ctx.on('tools/result', (exec, result) => { if (exec.name === 'sapper_tools' && !result.isError) directories.push(result.value) })
    const run = await dispatch()
    expect(directories[0]).toEqual([expect.objectContaining({ name: 'read', kind: 'native' })])
    expect(directories[1]).toMatchObject({ selected: [], availableTools: [expect.objectContaining({ name: 'read' })] })
    expect(run).toMatchObject({ state: 'failed', stop_reason: expect.stringContaining('SAPPER_PLANNING_EMPTY'), explored: 0 })
    expect(read).not.toHaveBeenCalled()
  })

  it('surfaces an explicit planning blocker in the persisted run and main-session result, and permits resuming', async () => {
    const scenario: Scenario = { blockedReason: 'Attachment password has not been provided' }
    const { ctx, cwd, parent, model } = await setup(scenario, { verification: { mode: 'none' } }, true, 1, 'global', false)
    const service = ctx.get('sapperPanel') as TaskPanelService, events: import('../src/panel/result.js').TaskResult[] = []
    ctx.on('session/event', (session, event) => { const result = resultOfEvent(event); if (session === parent.session && result) events.push(result) })
    service.submit(parent, { action: 'start', goal: 'Inspect attachment' })
    await service.whenIdle(cwd)
    const first = (await service.state(String(parent.id))).job!
    expect(first).toMatchObject({ state: 'failed', result: { state: 'failed', stop_reason: expect.stringContaining('Attachment password'), errors: [expect.stringContaining('SAPPER_PLANNING_BLOCKED')] } })
    expect(events.at(-1)).toMatchObject({ phase: 'result', state: 'failed', errors: [expect.stringContaining('Attachment password')] })
    expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(false)
    delete scenario.blockedReason
    service.submit(parent, { action: 'resume', task_id: first.result!.task_id })
    await service.whenIdle(cwd)
    expect((await service.state(String(parent.id))).job).toMatchObject({ state: 'completed', result: { run_id: 'r002' } })
  })

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
    await waitForRuntime(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
    controller.abort(new Error('fixture-cancelled'))
    await expect(pending).rejects.toThrow('aborted')
    await waitForRuntime(async () => expect((await store.readRun('r001')).state).toBe('cancelled'))
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
      await waitForRuntime(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
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
    await waitForRuntime(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
    parent.session.append('sandbox/mode', { mode: 'read-only' })
    await pending
    await waitForRuntime(() => expect(ctx.agents.list()).toEqual([parent]))
    expect((await store.readRun('r001')).state).toBe('running')
    parent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect(await execute('sapper_dispatch', { mode: 'recover', run_id: 'r001' })).toMatchObject({ state: 'cancelled' })
    expect((await store.read()).intents[0]?.worker).toBeNull()
    expect((await store.read()).facts.filter(f => f.id !== 'goal')).toHaveLength(1)
  })
  it('stops children on plugin disable and removes the dispatch tool', async () => {
    const { dispatch, model, ctx, parent, setConfig } = await setup({ hang: true })
    const pending = dispatch().catch(error => error)
    await waitForRuntime(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
    setConfig({ enabled: false })
    await pending
    await waitForRuntime(() => expect(ctx.agents.list()).toEqual([parent]))
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

it('inherits parent-visible MCP tools from a preset and records independent MCP evidence for both roles', async () => {
  const name = 'mcp__ida__decompile', { dispatch, store, model, read } = await setup({ externalName: name, registeredTools: [name] }, {}, false, 1, 'preset-ptc')
  const run = await dispatch()
  expect(run.state, JSON.stringify(run)).toBe('completed')
  expect(read).toHaveBeenCalledTimes(2)
  const outcome = (await store.readRun(run.id)).outcomes[0]!
  expect(outcome.candidate?.evidence[0]?.tool).toBe(name)
  expect(outcome.verification?.evidence[0]?.tool).toBe(name)
  expect(outcome.candidate?.explorer_session).not.toBe(outcome.verification?.verifier_session)
  expect(run.children?.filter((c) => c.role !== 'reason').every((c) => c.external_tools.includes(name))).toBe(true)
  for (const r of model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper reason'))) expect(r.tools?.map((t) => t.name)).not.toContain(name)
})
it('limits MCP prefixes to the selected server and configures verifier tools independently', async () => {
  const name = 'mcp__ida__decompile', other = 'mcp__browser__navigate', { dispatch, model } = await setup({ externalName: name, verifyExternalName: 'read', registeredTools: [name, other] }, { orchestration: { exploreTools: ['mcp__ida__*'], verifyTools: ['read'] } })
  expect((await dispatch()).state).toBe('completed')
  for (const r of model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper explore'))) {
    expect(r.tools?.map((t) => t.name)).toContain(name)
    expect(r.tools?.map((t) => t.name)).not.toContain(other)
    expect(r.tools?.map((t) => t.name)).not.toContain('read')
  }
  for (const r of model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper verify'))) expect(r.tools?.map((t) => t.name)).not.toContain(name)
})
it('never restores an MCP tool denied in the parent even when its exact name is configured', async () => {
  const name = 'mcp__ida__decompile', { parent, dispatch, model, read, ctx, config } = await setup({ externalName: name, registeredTools: [name] }, { orchestration: { exploreTools: [name] } }, false, 1, 'preset')
  parent.ctx.tools.restrict({ deny: [name] })
  const { capabilities } = await import('../src/panel/capabilities.js')
  expect((await capabilities(ctx, config, String(parent.id))).tools.find((t) => t.name === name)).toMatchObject({ available: false, explore: false })
  expect((await dispatch()).stop_reason).toContain('SAPPER_M3_TOOL_UNAVAILABLE')
  expect(model.requests).toHaveLength(1)
  expect(read).not.toHaveBeenCalled()
})
it('refreshes MCP tools registered between child inference boundaries without changing parent presentation', async () => {
  const scenario: Scenario = {}, { ctx, dispatch, model } = await setup(scenario, {}, false, 1, 'preset-ptc')
  let registered = false
  scenario.beforeRead = async () => {
    if (registered) return
    registered = true
    ctx.tools.register(defineTool({ name: 'mcp__ida__late', description: 'Late MCP capability', parameters: {}, output: { schema: { type: 'string' }, render: (_a,v) => [{ type: 'text', text: v }] }, execute: async () => 'late' }))
  }
  expect((await dispatch()).state).toBe('completed')
  const explore = model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper explore'))
  expect(explore[0]?.tools?.map((t) => t.name)).not.toContain('mcp__ida__late')
  expect(explore.at(-1)?.tools?.map((t) => t.name)).toContain('mcp__ida__late')
})
it('honors a parent MCP revocation at the final execution guard after a tool was advertised', async () => {
  const name = 'mcp__ida__decompile', { ctx, parent, dispatch, read, store } = await setup({ externalName: name, registeredTools: [name] }, { orchestration: { maxVerify: 1 } })
  let denied = false
  ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === name && !denied) { denied = true; parent.ctx.tools.restrict({ deny: [name] }) } return next() })
  const run = await dispatch()
  expect(run.state).toBe('failed')
  expect(read).not.toHaveBeenCalled()
  expect((await store.read()).facts.some((f) => f.verification_status === 'confirmed')).toBe(false)
})
it('passes adapter-owned default and role reasoning efforts into actual child requests', async () => {
  const { dispatch, model } = await setup({}, { orchestration: { reasoningEffort: 'fixture-max', reasoningEfforts: { verify: 'fixture-low' } } })
  const run = await dispatch()
  expect(run.state, JSON.stringify(run)).toBe('completed')
  for (const r of model.requests) expect(r.reasoningEffort).toBe(JSON.stringify(r.messages).includes('# Sapper verify') ? 'fixture-low' : 'fixture-max')
  expect(run.children?.find((c) => c.role === 'verify')?.reasoning_effort).toBe('fixture-low')
})
it('inherits parent reasoning effort and lets a changed role model resolve its own default', async () => {
  const { dispatch, model } = await setup({ parentEffort: 'fixture-max' }, { orchestration: { models: { verify: 'fixture:fixture-other' } } })
  expect((await dispatch()).state).toBe('completed')
  const verify = model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper verify'))
  expect(verify.length).toBeGreaterThan(0)
  for (const r of verify) { expect(r.model).toBe('fixture-other'); expect(r.reasoningEffort).toBeUndefined() }
  for (const r of model.requests.filter((r) => !JSON.stringify(r.messages).includes('# Sapper verify'))) expect(r.reasoningEffort).toBe('fixture-max')
})
it('rejects unsupported reasoning before any child model request instead of silently guessing an effort', async () => {
  const { dispatch, model } = await setup({}, { orchestration: { reasoningEffort: 'invented-max' } })
  const run = await dispatch()
  expect(run.state).toBe('failed')
  expect(run.stop_reason).toContain('SAPPER_REASONING_UNSUPPORTED')
  expect(model.requests).toHaveLength(0)
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

it(
  'drives the task panel through actual client and host Typert Gateways with strict wire schemas',
  async () => {
    const { default: Registry } = await import(
      '@deepseek-ai/dsh-typert-registry'
    )
    const { default: Gateway } = await import('@deepseek-ai/dsh-api-gateway')
    const { RemoteAccessService } = await import(
      '@deepseek-ai/dsh-api-remote-access'
    )
    const ClientGateway = await import('@deepseek-ai/dsh-api-gateway/client')
    const { PANEL_REMOTE } = await import('../src/panel/rpc.js')
    const panelScenario: Scenario = { completesGoal: true, writeup: false, registeredTools: ['mcp__ida__decompile', 'mcp__browser__navigate'] }
    const { ctx, parent, cwd } = await setup(
      panelScenario,
      {},
      false,
      1,
      'preset',
      false,
    )
    await ctx.plugin(Registry)
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(Gateway, {})
    const peerCtx = ctx.extend(),
      controller = new AbortController()
    const peer = { id: 'panel-owner' as import('@deepseek-ai/dsh-typert-protocol').PeerId, ctx: peerCtx, principal: { kind: 'owner' as const }, signal: controller.signal, interactions: 'none' as const, dispose: async () => {} }
    const client = new Context()
    cleanup.push(() => client.fiber.dispose())
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
    await waitForRuntime(() => expect(connection.getSnapshot().api, connection.getSnapshot().error).toBeDefined())
    expect(wrongScope).toThrow(/without inject/)
    const invoke = async (method: string, args: { sessionId?: string; input?: import('../src/panel/rpc.js').PanelAction }) => {
    const api = connection.getSnapshot().api!
    if (method === 'targets') return api.targets()
    if (method === 'state') return api.state(args.sessionId!)
    if (method === 'report') return api.report!(args.sessionId!)
    return api.action(args.sessionId!, args.input!)
  }
    expect(await invoke('targets', {})).toEqual([
      { id: String(parent.id), cwd },
    ])
    const capabilityList = await connection.getSnapshot().api!.capabilities!({ sessionId: String(parent.id) })
    expect(capabilityList.tools.find((t) => t.name === 'read')).toMatchObject({ available: true, explore: true, verify: true })
    expect(capabilityList.models.find((m) => m.id === 'fixture-model')?.efforts.map((e) => e.id)).toEqual(['fixture-low', 'fixture-max'])
    await expect(ctx.typertGateway.invoke({ namespace: 'sapperPanel', method: 'capabilities', args: { input: { cwd: '/forged' } }, peer })).rejects.toThrow()
    const brokerState = await connection.getSnapshot().api!.brokerState!()
    expect(brokerState.providers).toContain('native-handle')
    const updatedBroker = await connection.getSnapshot().api!.brokerConfigure!({ revision: brokerState.revision, policy: { ...brokerState.policy, waitMs: 2300 } })
    expect(updatedBroker.revision).toBe(brokerState.revision + 1)
    expect((await connection.getSnapshot().api!.brokerState!()).policy.waitMs).toBe(2300)
    await expect(ctx.typertGateway.invoke({ namespace: 'sapperPanel', method: 'brokerConfigure', args: { input: { revision: updatedBroker.revision, policy: updatedBroker.policy, ownerId: 'forged' } }, peer })).rejects.toThrow()
    expect(await invoke('state', { sessionId: String(parent.id) })).toMatchObject({ tasks: [], runs: [] })
    const panelResults: import('../src/panel/result.js').TaskResult[] = []
    ctx.on('session/event', (session, event) => {
      if (
        session === parent.session &&
        resultOfEvent(event)?.phase === 'result'
      )
        panelResults.push(resultOfEvent(event)!)
    })
    await invoke('action', { sessionId: String(parent.id), input: { action: 'start', goal: 'Verify local fixture' } })
    await (ctx.get('sapperPanel') as TaskPanelService).whenIdle(cwd)
    expect(await invoke('state', { sessionId: String(parent.id) })).toMatchObject({ job: { state: 'completed', result: { stop_reason: 'goal-completed' } }, graph: { status: 'completed', verified: 1 } })
    await expect(ctx.typertGateway.invoke({ namespace: 'sapperPanel', method: 'action', args: { sessionId: String(parent.id), input: { action: 'start', cwd: '/forged' } }, peer })).rejects.toThrow()
    if (process.env.SAPPER_BROWSER_PROBE === '1') {
      await ctx.plugin(CommandRuntime)
      const panel = await mountNative(ctx, cwd, true)
      const { DirectoryPicker } = await import('@deepseek-ai/dsh-host-directory-picker')
      const { DirectoryPickerController } = await import('@deepseek-ai/dsh-api-workspace-controller')
      const { readdir, realpath } = await import('node:fs/promises')
      await ctx.plugin(class extends DirectoryPicker {
        private picker = {
          kind: 'browse' as const,
          list: async (requested?: string) => {
            const current = await realpath(requested || cwd)
            return { path: current, home: cwd, crumbs: [{ name: path.basename(current), path: current, hidden: false }], entries: (await readdir(current, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, path: path.join(current, e.name), hidden: e.name.startsWith('.') })), truncated: false }
          },
          createDirectory: async () => { throw new Error('not used') },
        }
        constructor(scoped: Context) { super(scoped) }
        capability() { return this.picker }
      })
      await ctx.plugin(DirectoryPickerController)
      panelScenario.emptyReason = true
      const { workbenchBrowser } = await import(
        './fixtures/workbench-browser.js'
      )
      await workbenchBrowser(
        panel,
        cwd,
        (namespace, method, args) =>
          ctx.typertGateway.invoke({ namespace, method, args, peer }),
        () => {
          panelScenario.emptyReason = false
          panelScenario.writeup = true
        },
        uploadRoutes.get(panel)!,
      )
    }

    await consumer.dispose()
  },
  process.env.SAPPER_BROWSER_PROBE === '1' ? 45000 : 20000,
)

it('resumes a failed legacy workspace graph through the panel without recreating facts or rerunning reason', async () => {
  const scenario = { forged: true, completesGoal: true }
  const { ctx, cwd, parent, dispatch, store, model } = await setup(scenario)
  const first = await dispatch()
  expect(first.state).toBe('failed')
  const saved = await store.readRun(first.id),
    before = model.requests.length
  scenario.forged = false
  const service = ctx.get('sapperPanel') as TaskPanelService
  await service.action(String(parent.id), {
    action: 'resume',
    task_id: 'legacy',
  })
  await service.whenIdle(cwd)
  expect(await service.state(String(parent.id))).toMatchObject({ active: 'legacy', job: { state: 'completed' }, graph: { status: 'completed', verified: 1 } })
  expect(await store.readRun(first.id)).toEqual(saved)
  expect((await store.read()).facts.find(f => f.id === 'f001')?.description).toBe('A local fixture.txt is available')
  expect(
    model.requests
      .slice(before)
      .filter((r) => !JSON.stringify(r.messages).includes('SAPPER_MAIN_BRIEF'))
      .some(
        (r) =>
          !JSON.stringify(r.messages).includes('# Sapper explore') &&
          !JSON.stringify(r.messages).includes('# Sapper verify'),
      ),
  ).toBe(false)
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
it('publishes result cards and produces a single real parent brief without replaying on report', async () => {
  const scenario: Scenario = { maxTokens: 'verify' }
  const { ctx, cwd, parent } = await setup(
    scenario,
    {},
    true,
    1,
    'preset',
    false,
  )
  const results: import('../src/panel/result.js').TaskResult[] = []
  const parentTurns: string[] = []
  ctx.on('session/event', (session, event) => {
    if (session !== parent.session) return
    const result = resultOfEvent(event)
    if (result && (!result.phase || result.phase === 'result'))
      results.push(result)
    if (event.type === 'turn/start') parentTurns.push(event.type)
  })
  const service = ctx.get('sapperPanel') as TaskPanelService
  await ctx.commands.execute(parent, '/sapper start Verify local fixture', [], new AbortController().signal)
  await service.whenIdle(cwd)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ state: 'failed', confirmed: [], candidates: [{ status: 'unverified', description: expect.stringContaining('VERIFIED-LOCAL-7C42') }] })
  delete scenario.maxTokens
  await ctx.commands.execute(
    parent,
    '/sapper run',
    [],
    new AbortController().signal,
  )
  await service.whenIdle(cwd)
  expect(results).toHaveLength(2)
  expect(results[1]).toMatchObject({ state: 'completed', confirmed: [{ id: 'f002' }], candidates: [] })
  await service.briefs.whenIdle(String(parent.id))
  expect(parentTurns).toHaveLength(2)
  const report = await ctx.commands.execute(parent, '/sapper result', [], new AbortController().signal)
  expect(report?.result.kind).toBe('success')
  expect(results).toHaveLength(3)
  await parent.whenIdle()
  expect(parentTurns).toHaveLength(2)
})

it('denies extra evidence calls after entering finalization even when a model ignores the finish notice', async () => {
  const { dispatch, read } = await setup({ exploreReads: 4 }, { orchestration: { budgetMode: 'fixed', maxChildSteps: 3 } })
  const run = await dispatch()
  expect(run.state).toBe('failed')
  expect(run.outcomes[0]?.error).toContain('步数预算')
  expect(read).toHaveBeenCalledTimes(1)
})

it('collects the requested number of distinct flags, reports each immediately and does not start verifier agents', async () => {
  const values = ['CTF2{MULTI-A}', 'CTF2{MULTI-B}'], { ctx, parent, cwd, model } = await setup({ flagValues: values, proposals: 2, reasonOnce: true }, { flags: { completion: 'count', targetCount: 2 }, verification: { mode: 'none' }, orchestration: { concurrency: 1, maxSteps: 6, maxExplore: 6 } }, true, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService, events: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (_s,e) => { const result = resultOfEvent(e); if (result?.phase === 'flag-found') events.push(result) })
  service.submit(parent, { action: 'start', goal: '收集两个不同 flag' })
  await service.whenIdle(cwd)
  const state = await service.state(String(parent.id)), result = state.job!.result!
  expect(result.stop_reason).toBe('flag-target-reached')
  expect(result.flag_progress).toMatchObject({ found: 2, target: 2, confirmed: 0 })
  expect(events.some((e) => e.flag_progress?.found === 1 && e.state === 'running')).toBe(true)
  expect(result.candidates.filter((c) => c.kind === 'flag').map((c) => c.description).sort()).toEqual(values)
  expect(model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toHaveLength(0)
  expect(ctx.agents.list()).toEqual([parent])
})
it('continues past flags in all mode and ignores a premature completes_goal claim from a verifier', async () => {
  const { dispatch, store, model } = await setup({ flagValues: ['CTF2{ALL-A}', 'CTF2{ALL-B}'], proposals: 2, completesGoal: true, reasonOnce: true }, { flags: { completion: 'all' }, verification: { mode: 'independent' }, orchestration: { concurrency: 1, maxSteps: 6, maxExplore: 6 } })
  const run = await dispatch()
  expect(run.state, JSON.stringify(run)).toBe('completed')
  expect(run.stop_reason).toBe('no-new-intents')
  expect(run.flag_progress).toMatchObject({ found: 2, confirmed: 2 })
  expect(run.outcomes.filter((o) => o.state === 'confirmed')).toHaveLength(2)
  expect((await store.read()).project.status).toBe('active')
  expect(model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper verify')).length).toBeGreaterThanOrEqual(2)
})
it('deduplicates repeated flag values and does not claim the requested target was reached', async () => {
  const { dispatch, store } = await setup({ flagValues: ['CTF2{SAME}', 'CTF2{SAME}'], proposals: 2, reasonOnce: true }, { flags: { completion: 'count', targetCount: 2 }, verification: { mode: 'none' }, orchestration: { maxSteps: 6, maxExplore: 6 } })
  const run = await dispatch()
  expect(run.stop_reason).toBe('no-new-intents')
  expect(run.flag_progress).toMatchObject({ found: 1, target: 2 })
  expect((await store.readRun(run.id)).flag_observations).toHaveLength(1)
})
it('resumes a first-flag run in the same graph with a larger target and preserves its earlier run', async () => {
  const { execute, dispatch, store, model } = await setup({ flagValues: ['CTF2{RESUME-A}', 'CTF2{RESUME-B}'], proposals: 2, reasonOnce: true }, { orchestration: { concurrency: 1, maxSteps: 6, maxExplore: 6 } })
  const first = await dispatch(), original = await readFile(path.join(store.root, 'runs', first.id + '.json'), 'utf8')
  expect(first.stop_reason).toBe('flag-found')
  const result = await execute('sapper_dispatch', { mode: 'run', flag_mode: 'count', flag_count: 2, verification_mode: 'none' }) as unknown as RunRecord
  expect(result.flag_progress).toMatchObject({ found: 2, target: 2 })
  expect(result.stop_reason).toBe('flag-target-reached')
  expect(await readFile(path.join(store.root, 'runs', first.id + '.json'), 'utf8')).toBe(original)
  expect((await store.read()).integrity).toEqual([])
  expect(model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toHaveLength(0)
})
it('records fast evidence without a verifier and still permits explicit independent verification afterwards', async () => {
  const { dispatch, store, model } = await setup({ completesGoal: true }, { verification: { mode: 'none' }, orchestration: { maxSteps: 3, maxExplore: 3 } })
  const fast = await dispatch()
  expect(fast.state, JSON.stringify(fast)).toBe('completed')
  expect(fast.stop_reason).toBe('evidence-goal-reached')
  expect(fast.outcomes[0]).toMatchObject({ state: 'observed', verify_attempts: 0, evidence_check: { mode: 'none' } })
  expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
  expect((await store.read()).facts.some((f) => f.verification_status === 'confirmed')).toBe(false)
  const checked = await dispatch('verify', { run_id: fast.id, intent_id: fast.outcomes[0]!.intent_id })
  expect(checked.outcomes[0]?.state).toBe('confirmed')
  expect((await store.read()).integrity).toEqual([])
})
it('lightly checks important flag evidence in the explorer with two actual receipts, without a second agent', async () => {
  const { dispatch, model, store } = await setup({ flagValues: ['CTF2{LIGHT-A}'], exploreReads: 2, citeAll: true, reasonOnce: true }, { flags: { completion: 'all' }, verification: { mode: 'lightweight' }, orchestration: { maxSteps: 4, maxExplore: 4 } })
  const run = await dispatch()
  expect(run.outcomes[0], JSON.stringify(run)).toMatchObject({ state: 'observed', evidence_check: { mode: 'lightweight', passed: true } })
  expect((await store.readRun(run.id)).outcomes[0]?.candidate?.evidence).toHaveLength(2)
  expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
})
it('retains a one-receipt important observation without secretly launching a verifier to fill the missing check', async () => {
  const { dispatch, model } = await setup({ flagValues: ['CTF2{ONE-RECEIPT}'], reasonOnce: true }, { flags: { completion: 'all' }, verification: { mode: 'lightweight' }, orchestration: { maxSteps: 3, maxExplore: 3 } })
  const run = await dispatch()
  expect(run.outcomes[0]).toMatchObject({ state: 'observed', evidence_check: { passed: false } })
  expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
})
it('selectively verifies configured important kinds while ordinary notes use fast evidence recording', async () => {
  const ordinary = await setup({ completesGoal: true }, { verification: { mode: 'selective', criticalKinds: ['flag'] } })
  expect((await ordinary.dispatch()).outcomes[0]?.state).toBe('observed')
  expect(ordinary.model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
  const important = await setup({ flag: 'CTF2{SELECTIVE}', reasonOnce: true }, { flags: { completion: 'all' }, verification: { mode: 'selective', criticalKinds: ['flag'] }, orchestration: { maxSteps: 3, maxExplore: 3 } })
  expect((await important.dispatch()).outcomes[0]?.state).toBe('confirmed')
  expect(important.model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(true)
})

it('keeps other collection routes running after a flag and cancels them explicitly without losing that result', async () => {
  const { ctx, parent, cwd, model } = await setup({ flagValues: ['CTF2{KEEP-A}', 'CTF2{KEEP-B}'], proposals: 2, hangOther: true }, { flags: { completion: 'all' }, verification: { mode: 'none' }, orchestration: { concurrency: 2, maxSteps: 4, maxExplore: 4 } }, true, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService, events: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (_s,e) => { const result = resultOfEvent(e); if (result?.phase === 'flag-found') events.push(result) })
  service.submit(parent, { action: 'start', goal: '持续收集所有 flag' })
  await waitForRuntime(() => expect(events.some((e) => e.candidates.some((c) => c.description === 'CTF2{KEEP-A}'))).toBe(true))
  expect((await service.state(String(parent.id))).job?.state).toBe('running')
  service.submit(parent, { action: 'cancel' }); await service.whenIdle(cwd)
  const result = (await service.state(String(parent.id))).job!
  expect(result.state).toBe('cancelled')
  expect(result.result?.candidates.some((c) => c.description === 'CTF2{KEEP-A}')).toBe(true)
  expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
  expect(ctx.agents.list()).toEqual([parent])
})

it('carries a main-session request to disable review into the automatically steered follow-up', async () => {
  const scenario: Scenario = { hang: true }, { ctx, parent, cwd, model } = await setup(scenario, {}, true, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService
  service.submit(parent, { action: 'start', goal: '原独立复核任务' })
  await waitForRuntime(() => expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
  scenario.hang = false; scenario.completesGoal = true
  service.submit(parent, { action: 'steer', goal: '取消自动复核，继续收集其他 flag', flag_mode: 'all', verification_mode: 'none' })
  await service.whenIdle(cwd)
  const state = await service.state(String(parent.id)), store = new GraphStore((await resolveSelectedStore(cwd, resolveConfig()))!, cwd)
  expect(state.job?.state).toBe('completed')
  expect((await store.read()).project).toMatchObject({ verification_mode: 'none', flag_policy: { mode: 'all' } })
  expect(state.runs[0]?.outcomes[0]?.state).toBe('observed')
  expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(false)
})

it('ends on the first evidence-backed flag, immediately reports it, drains competing exploration and never starts verification or another reason', async () => {
  const { ctx, cwd, parent, model } = await setup({ flag: 'CTF2{STOP-FIRST-7C42}', proposals: 2, hangOther: true }, { orchestration: { maxSteps: 8, maxExplore: 8, concurrency: 2 } }, true, 1, 'preset', false)
  const events: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (session, event) => {
    if (session === parent.session && resultOfEvent(event))
      events.push(resultOfEvent(event)!)
  })
  const service = ctx.get('sapperPanel') as TaskPanelService
  service.submit(parent, {
    action: 'start',
    goal: 'Find flag and stop immediately',
  })
  expect(events[0]).toMatchObject({ phase: 'accepted', state: 'queued' })
  await service.whenIdle(cwd)
  const state = await service.state(String(parent.id)),
    run = state.runs[0]!
  expect(state.job?.state).toBe('completed')
  expect(run).toMatchObject({ state: 'completed', stop_reason: 'flag-found' })
  expect(run.children?.filter((c) => c.role === 'verify')).toEqual([])
  expect(run.children?.filter((c) => c.role === 'reason')).toHaveLength(1)
  expect(events.find(e => e.phase === 'flag-found')).toMatchObject({ candidates: [{ description: 'CTF2{STOP-FIRST-7C42}', status: 'unverified' }] })
  expect(events.at(-1)).toMatchObject({ phase: 'result', confirmed: [], candidates: [{ description: 'CTF2{STOP-FIRST-7C42}' }] })
  expect(state.graph?.verified).toBe(0)
  expect(ctx.agents.list()).toEqual([parent])
  const store = new GraphStore(
    (await resolveSelectedStore(cwd, resolveConfig()))!,
    cwd,
  )
  expect((await store.read()).intents.every((i) => i.worker === null)).toBe(
    true,
  )
  expect((await store.read()).hints).toEqual([])
  expect(model.requests.filter(r => JSON.stringify(r.messages).includes('# Sapper verify'))).toEqual([])
})

it.each(['CTF2{EARLY-OUTPUT-7C42}', 'NONSTANDARD-FLAG-7C42'])('publishes a flag before explorer disposal and keeps it available for explicit verification (%s)', async (flag) => {
  const { ctx, cwd, parent, model } = await setup({ flag }, {}, true, 1, 'preset', false),
    service = ctx.get('sapperPanel') as TaskPanelService,
    events: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (session, event) => { if (session === parent.session && resultOfEvent(event)) events.push(resultOfEvent(event)!) })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }),
    start = ctx.subagents.startActivation.bind(ctx.subagents)
  const spy = vi.spyOn(ctx.subagents, 'startActivation').mockImplementation(async (input) => {
    const activation = await start(input)
    if (input.label !== 'Sapper explore') return activation
    return { ...activation, dispose: async () => { await gate; await activation.dispose() } }
  })
  try {
    service.submit(parent, { action: 'start', goal: 'Find the flag and return it immediately' })
    await waitForRuntime(() => expect(events.some((e) => e.phase === 'flag-found')).toBe(true))
    expect(events.find((e) => e.phase === 'flag-found')).toMatchObject({ state: 'running', confirmed: [], candidates: [{ kind: 'flag', description: flag, status: 'unverified' }] })
    expect(events.some((e) => e.phase === 'result')).toBe(false)
    expect(model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toHaveLength(0)
    const state = await service.state(String(parent.id))
    expect(state.job?.state).toBe('running')
    const store = new GraphStore((await resolveSelectedStore(cwd, resolveConfig()))!, cwd)
    let run!: RunRecord
    // The packaged writer and source-side reader have separate in-process
    // queues. Wait for the managed writer's durable snapshot, respecting LOCK.
    await waitForRuntime(async () => {
      run = await store.readRun('r001')
      expect(run.flag_observations?.[0]?.candidate.description).toBe(flag)
    })
    expect(run.outcomes[0]?.candidate?.evidence).toHaveLength(1)
    expect(run.outcomes[0]?.verify_attempts).toBe(0)
    release()
    await service.whenIdle(cwd)
    expect((await service.state(String(parent.id))).job?.result?.candidates[0]?.description).toBe(flag)
    service.submit(parent, { action: 'verify', task_id: state.active, run_id: 'r001', intent_id: run.outcomes[0]!.intent_id })
    await service.whenIdle(cwd)
    expect((await service.state(String(parent.id))).graph?.verified).toBe(1)
  } finally { release(); spy.mockRestore(); await service.whenIdle(cwd) }
})

it('keeps an unverified flag visible while optional verification is blocked and confirms it only afterwards', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }),
    { ctx, cwd, parent, store, model } = await setup({ flag: 'CTF2{VERIFY-LATER-7C42}', verifyGate: gate }, {}, true),
    project = JSON.parse(await readFile(path.join(store.root, 'project.json'), 'utf8'))
  project.stop_on_flag = false
  await writeFile(path.join(store.root, 'project.json'), JSON.stringify(project))
  const service = ctx.get('sapperPanel') as TaskPanelService, events: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (session, event) => { if (session === parent.session && resultOfEvent(event)) events.push(resultOfEvent(event)!) })
  try {
    service.submit(parent, { action: 'run' })
    await waitForRuntime(() => expect(model.requests.some((r) => JSON.stringify(r.messages).includes('# Sapper verify'))).toBe(true))
    expect(events.filter((e) => e.phase === 'flag-found')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ state: 'running', confirmed: [], candidates: [{ kind: 'flag', description: 'CTF2{VERIFY-LATER-7C42}', status: 'unverified' }] })
    expect((await service.state(String(parent.id))).graph?.verified).toBe(0)
    const result = await service.result(parent, 'read-only-snapshot')
    expect(result.candidates[0]?.description).toBe('CTF2{VERIFY-LATER-7C42}')
    release()
    await service.whenIdle(cwd)
    expect(events.at(-1)).toMatchObject({ phase: 'result', candidates: [], confirmed: [{ description: 'CTF2{VERIFY-LATER-7C42}', kind: 'flag' }] })
  } finally { release(); await service.whenIdle(cwd) }
})

it('does not broadcast a flag invented by the model without successful external evidence', async () => {
  const { ctx, cwd, parent } = await setup({ flag: 'CTF2{MODEL-ONLY-7C42}', forged: true }, {}, true, 1, 'global', false),
    service = ctx.get('sapperPanel') as TaskPanelService, events: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (session, event) => { if (session === parent.session && resultOfEvent(event)) events.push(resultOfEvent(event)!) })
  service.submit(parent, { action: 'start', goal: 'Find CTF2{MODEL-ONLY-7C42}, which is only a prompt string' })
  await service.whenIdle(cwd)
  expect(events.some((e) => e.phase === 'flag-found')).toBe(false)
  expect(events.at(-1)?.candidates).toEqual([])
})

it('accepts a main-session steering tool, drains the old route and automatically runs a linked phase with the new direction', async () => {
  const scenario: Scenario = { hang: true }
  const { ctx, cwd, parent, model, execute } = await setup(scenario, {}, true, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService
  service.submit(parent, { action: 'start', goal: 'Find evidence' })
  await waitForRuntime(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
  const first = await resolveSelectedStore(cwd, resolveConfig())
  scenario.hang = false
  expect(await execute('sapper_control', { action: 'steer', goal: 'Explore the other direction, checking local fixture' })).toMatchObject({ accepted: true, state: 'cancelling' })
  await service.whenIdle(cwd)
  const state = await service.state(String(parent.id))
  expect(state.tasks).toHaveLength(2)
  expect(state.tasks[1]?.goal).toContain('Explore the other direction')
  expect((await new GraphStore(first!, cwd).readRun('r001')).state).toBe('cancelled')
  const next = new GraphStore((await resolveSelectedStore(cwd, resolveConfig()))!, cwd)
  expect((await next.read()).project.parent_task).toBe(state.tasks[0]?.id)
  expect(state.job?.state).toBe('completed')
  expect(ctx.agents.list()).toEqual([parent])
})

it('allows WP and correction phases after a completed goal, preserves original evidence and does not treat historical flags as new success', async () => {
  const scenario: Scenario = { completesGoal: true, writeup: false }
  const { ctx, cwd, parent, execute } = await setup(
    scenario,
    {},
    true,
    1,
    'preset',
    false,
  )
  const service = ctx.get('sapperPanel') as TaskPanelService
  service.submit(parent, { action: 'start', goal: 'Verify original evidence' })
  await service.whenIdle(cwd)
  const first = new GraphStore((await resolveSelectedStore(cwd, resolveConfig()))!, cwd), original = await first.read()
  expect(original.project.status).toBe('completed')
  scenario.writeup = true
  scenario.flag = 'CTF2{HISTORICAL-WP-ONLY-7C42}'
  const notices: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (session, event) => { if (session === parent.session && resultOfEvent(event)) notices.push(resultOfEvent(event)!) })
  await ctx.commands.execute(parent, '/sapper wp Include the reproduction steps', [], new AbortController().signal)
  await service.whenIdle(cwd)
  expect(notices.some((event) => event.phase === 'flag-found')).toBe(false)
  const wp = new GraphStore(
    (await resolveSelectedStore(cwd, resolveConfig()))!,
    cwd,
  )
  expect(await readFile(path.join(cwd, 'WP.md'), 'utf8')).toContain(
    'Reproduction:',
  )
  expect((await wp.read()).project).toMatchObject({
    purpose: 'writeup',
    stop_on_flag: false,
  })
  const wpBytes = await readFile(path.join(cwd, 'WP.md'), 'utf8')
  const address = {
    workspaceId: 'session:' + String(parent.id),
    taskId: path.basename(wp.root),
    runId: 'r001',
  }
  expect(
    (await service.detail(address)).files.find((f) => f.name === 'WP.md')
      ?.snapshot,
  ).toBe(true)
  await writeFile(
    path.join(cwd, 'WP.md'),
    'Later updated WP; flag now independently verified',
  )
  expect((await service.file(address, 'WP.md')).text).toBe(wpBytes)
  expect(
    (
      await service.detail({
        workspaceId: 'session:' + String(parent.id),
        taskId: path.basename(first.root),
        runId: 'r001',
      })
    ).state.graph?.goal,
  ).toBe('Verify original evidence')
  expect((await service.state(String(parent.id))).active).toBe(
    path.basename(wp.root),
  )
  expect((await wp.read()).facts.find(f => f.title === '前序任务与证据线索')?.doc).toContain('VERIFIED-LOCAL-7C42')
  scenario.writeup = false
  await execute('sapper_control', { action: 'continue', purpose: 'solve' })
  await service.whenIdle(cwd)
  const history = (await service.state(String(parent.id))).tasks
  expect(history).toHaveLength(3)
  expect(history[2]?.goal).toBe('Verify original evidence')
  expect(await first.read()).toEqual(original)
  expect((await wp.read()).project.status).toBe('completed')
})

it('retains a flag candidate for explicit independent verification and stops again without duplicate promotion', async () => {
  const { dispatch, store } = await setup({ flag: 'flag{VERIFY-LATER-7C42}' })
  const first = await dispatch()
  expect(first.stop_reason).toBe('flag-found')
  expect(first.outcomes[0]?.verify_attempts).toBe(0)
  const verified = await dispatch('verify', { run_id: first.id, intent_id: first.outcomes[0]!.intent_id })
  expect(verified).toMatchObject({ state: 'completed', stop_reason: 'flag-found', outcomes: [{ state: 'confirmed', verify_attempts: 1 }] })
  const after = await dispatch()
  expect(after).toMatchObject({ state: 'completed', stop_reason: 'flag-found', explored: 0 })
  expect((await store.read()).facts.filter(f => f.kind === 'flag')).toHaveLength(1)
  expect((await store.read()).integrity).toEqual([])
})

it('keeps background control inside the main session permission boundary and lets an explicit cancel discard a queued direction', async () => {
  const scenario: Scenario = { hang: true }
  const { ctx, cwd, parent, model, execute } = await setup(scenario, {}, true, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService
  parent.session.append('sandbox/mode', { mode: 'read-only' })
  await expect(execute('sapper_control', { action: 'continue', goal: 'Switch direction' })).rejects.toThrow('只读')
  expect((await service.state(String(parent.id))).tasks).toHaveLength(0)
  parent.session.append('sandbox/mode', { mode: 'danger-full-access' })
  service.submit(parent, { action: 'start', goal: 'Find evidence' })
  await waitForRuntime(() => expect(model.requests.some(r => JSON.stringify(r.messages).includes('# Sapper explore'))).toBe(true))
  await execute('sapper_control', { action: 'steer', goal: 'Switch direction' })
  service.submit(parent, { action: 'cancel' })
  await service.whenIdle(cwd)
  expect((await service.state(String(parent.id))).tasks).toHaveLength(1)
  expect(ctx.agents.list()).toEqual([parent])
})

it('reports durable partial results after cancellation instead of losing already confirmed evidence', async () => {
  const { ctx, cwd, parent } = await setup({ proposals: 2, hangOther: true }, { orchestration: { maxExplore: 2, maxSteps: 2 } }, true, 1, 'preset', false)
  const service = ctx.get('sapperPanel') as TaskPanelService
  service.submit(parent, { action: 'start', goal: 'Check two routes' })
  await waitForRuntime(async () => expect((await service.state(String(parent.id))).graph?.verified).toBe(1))
  service.submit(parent, { action: 'cancel' }); await service.whenIdle(cwd)
  const state = await service.state(String(parent.id))
  expect(state.job).toMatchObject({ state: 'cancelled', result: { phase: 'result', confirmed: [{ description: 'Local fixture contains VERIFIED-LOCAL-7C42' }] } })
  expect(ctx.agents.list()).toEqual([parent])
})

const uploadRoutes = new WeakMap<TaskPanelService, (request: Request) => Promise<Response>>()
async function mountNative(ctx: Context, cwd: string, withUploads = false) {
  const [
    { default: Storage },
    Json,
    Domain,
    Persistence,
    { default: Workspace },
    { default: Registry },
    { RemoteAccessService },
    { default: DefaultModel },
    { default: Titles },
    { default: Query },
    { default: Controller },
    { default: Gateway },
  ] = await Promise.all([
    import('@deepseek-ai/dsh-storage'),
    import('@deepseek-ai/dsh-storage-json'),
    import('@deepseek-ai/dsh-storage-domain'),
    import('@deepseek-ai/dsh-session-persistence-jsonl'),
    import('@deepseek-ai/dsh-workspace'),
    import('@deepseek-ai/dsh-typert-registry'),
    import('@deepseek-ai/dsh-api-remote-access'),
    import('@deepseek-ai/dsh-agent-default-model'),
    import('@deepseek-ai/dsh-session-title'),
    import('@deepseek-ai/dsh-session-query'),
    import('@deepseek-ai/dsh-api-session-controller'),
    import('@deepseek-ai/dsh-api-gateway'),
  ])
  await ctx.plugin(Storage)
  await ctx.plugin(Json, { root: path.join(cwd, 'profile', 'domains') })
  await ctx.plugin(Domain, { backend: 'json' })
  await ctx.plugin(Persistence, {
    root: path.join(cwd, 'profile', 'sessions'),
    compression: 'none',
  })
  await ctx.plugin(await import('@deepseek-ai/dsh-session-checkpoint-policy'))
  await ctx.plugin(Workspace)
  if (!ctx.get('typert')) await ctx.plugin(Registry)
  if (!ctx.get('remoteAccess')) await ctx.plugin(RemoteAccessService)
  if (!ctx.get('typertGateway')) await ctx.plugin(Gateway, {})
  await ctx.plugin(DefaultModel, {
    provider: 'fixture',
    model: 'fixture-model',
  })
  await ctx.plugin(Titles, {
    fallbackMaxWords: 8,
    fallbackMaxBytes: 160,
    maxTitleBytes: 512,
  })
  await ctx.plugin(Query, [])
  let route: ((request: Request) => Promise<Response>) | undefined
  if (withUploads) {
    const { default: Attachments } = await import('@deepseek-ai/dsh-attachment-local')
    const { default: FileUploads } = await import('@deepseek-ai/dsh-client-file-upload')
    ctx.provide('connection', { fetch: { register: (entry: { path: string; fetch(request: Request): Promise<Response> }) => { if (entry.path === '/api/session/uploadFileBinary') route = entry.fetch; return () => {} } } } as never)
    await ctx.plugin(Attachments, { dshHome: path.join(cwd, 'profile') })
    await ctx.plugin(FileUploads)
  } else {
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
    ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1048576,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 8388608,
      maxImagePixels: 16777216,
      maxImageDimension: 8192,
      mediaTypes: ['image/png'],
    },
    } as never)
  }
  await ctx.plugin(Controller, { nativeOpen: false })
  await waitForRuntime(() => expect(ctx.get('sessionController')).toBeDefined())
  const panel = ctx.get('sapperPanel') as TaskPanelService
  await waitForRuntime(() => expect(panel.workbench.durable).toBe(true))
  if (withUploads) uploadRoutes.set(panel, route!)
  return panel
}
it('imports native streamed uploads before scheduling, preserves duplicate Chinese names and seeds the task attachment context', async () => {
  const { ctx, cwd, model } = await setup({ emptyReason: true }, {}, true, 1, 'global', false),
    panel = await mountNative(ctx, cwd, true), { randomUUID, createHash } = await import('node:crypto'),
    bytes = [Buffer.from([0, 1, 255, 80, 75, 0, 128]), Buffer.from('second file 中文\0')],
    input = { requestId: randomUUID(), rootDir: cwd, title: '', goal: '分析附件', attachments: bytes.map((b) => ({ id: randomUUID(), name: '题目.zip', bytes: b.length })) },
    ready = await panel.prepare(input), events: import('../src/panel/result.js').TaskResult[] = []
  ctx.on('session/event', (_session, event) => { const result = resultOfEvent(event); if (result?.job_id === input.requestId) events.push(result) })
  expect(ready.jobId).toBeUndefined()
  expect(model.requests).toHaveLength(0)
  await expect(panel.launch(input)).rejects.toThrow('附件尚未上传完成')
  for (let i = 0; i < bytes.length; i++) {
    const uploaded = await ctx.get('fileUploads')!.uploadStream({ sessionId: SessionId(ready.sessionId!), name: '题目.zip', data: (async function* () { yield bytes[i]!.subarray(0, 2); yield bytes[i]!.subarray(2) })() })
    const request = { requestId: input.requestId, attachmentId: input.attachments[i]!.id, receiptId: String(uploaded.receiptId) }
    const [one, two] = await Promise.all([panel.importAttachment(request), panel.importAttachment(request)])
    expect(one.files?.[i]?.sha256).toBe(createHash('sha256').update(bytes[i]!).digest('hex'))
    expect(one.files?.[i]?.path).toBe(two.files?.[i]?.path)
    expect(await readFile(path.join(one.cwd, one.files![i]!.path))).toEqual(bytes[i])
  }
  expect(model.requests).toHaveLength(0)
  const launch = await panel.launch(input)
  await panel.whenIdle(launch.cwd)
  const store = new GraphStore((await resolveSelectedStore(launch.cwd, resolveConfig()))!, launch.cwd)
  const fact = (await store.read()).facts.find((f) => f.title === '用户上传的题目附件')!
  expect(JSON.parse(fact.doc!).files).toHaveLength(2)
  expect(JSON.stringify(model.requests[0]?.messages)).toContain('用户上传的题目附件')
  expect(events.find((e) => e.phase === 'accepted')?.attachments).toHaveLength(2)
  expect((await panel.detail({ workspaceId: launch.workspaceId!, taskId: path.basename(store.root) })).attachments).toHaveLength(2)
  expect(launch.files?.[0]?.path).not.toBe(launch.files?.[1]?.path)
})

it('recovers an accepted upload after a storage failure and cold restart without re-uploading or duplicating the native launch', async () => {
  const first = await setup({ emptyReason: true }, {}, true, 1, 'global', false), panel = await mountNative(first.ctx, first.cwd, true),
    { randomUUID } = await import('node:crypto'), bytes = Buffer.from('durable upload bytes'),
    input = { requestId: randomUUID(), rootDir: first.cwd, title: '', goal: '恢复附件', attachments: [{ id: randomUUID(), name: 'sample.bin', bytes: bytes.length }] },
    prepared = await panel.prepare(input), uploads = first.ctx.get('fileUploads')!, provider = first.ctx.get('attachments')!,
    receipt = await uploads.uploadStream({ sessionId: SessionId(prepared.sessionId!), name: 'sample.bin', data: (async function* () { yield bytes })() })
  const fail = vi.spyOn(provider, 'readFileStream').mockImplementationOnce(async function* () { yield bytes.subarray(0, 1); throw new Error('fixture storage interruption') })
  await expect(panel.importAttachment({ requestId: input.requestId, attachmentId: input.attachments[0]!.id, receiptId: String(receipt.receiptId) })).rejects.toThrow('fixture storage interruption')
  expect(panel.workbench.snapshot().launches[input.requestId]?.files?.[0]?.source).toEqual(receipt.file)
  expect(first.model.requests).toHaveLength(0)
  fail.mockRestore()
  await first.ctx.fiber.dispose()
  const second = await setup({ emptyReason: true }, {}, true, 1, 'global', false), restored = await mountNative(second.ctx, first.cwd, true)
  const ready = await restored.prepare(input)
  expect(ready.sessionId).toBe(prepared.sessionId)
  expect(ready.workspaceId).toBe(prepared.workspaceId)
  expect(ready.files?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(await readFile(path.join(ready.cwd, ready.files![0]!.path))).toEqual(bytes)
  expect(second.model.requests).toHaveLength(0)
  const result = await restored.launch(input)
  await restored.whenIdle(result.cwd)
  expect(restored.workbench.snapshot().jobs[result.jobId!]).toMatchObject({ state: 'failed', result: { errors: [expect.stringContaining('SAPPER_PLANNING_EMPTY')] } })
})

it('refuses foreign upload receipts and preserves existing destination files without starting a model', async () => {
  const { ctx, cwd, parent, model } = await setup({ emptyReason: true }, {}, true, 1, 'global', false), panel = await mountNative(ctx, cwd, true),
    { randomUUID } = await import('node:crypto'), { mkdir } = await import('node:fs/promises'), bytes = Buffer.from('input'),
    input = { requestId: randomUUID(), rootDir: cwd, title: '', goal: '附件边界测试', attachments: [{ id: randomUUID(), name: '../CON.txt', bytes: bytes.length }] },
    prepared = await panel.prepare(input), uploads = ctx.get('fileUploads')!
  const foreign = await uploads.uploadStream({ sessionId: parent.id, name: '../CON.txt', data: (async function* () { yield bytes })() })
  await expect(panel.importAttachment({ requestId: input.requestId, attachmentId: input.attachments[0]!.id, receiptId: String(foreign.receiptId) })).rejects.toThrow('不属于本题会话')
  const destination = path.join(prepared.cwd, prepared.files![0]!.path)
  expect(path.relative(prepared.cwd, destination)).not.toMatch(/^\.\./)
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, 'user file')
  const receipt = await uploads.uploadStream({ sessionId: SessionId(prepared.sessionId!), name: '../CON.txt', data: (async function* () { yield bytes })() })
  await expect(panel.importAttachment({ requestId: input.requestId, attachmentId: input.attachments[0]!.id, receiptId: String(receipt.receiptId) })).rejects.toThrow('未覆盖')
  expect(await readFile(destination, 'utf8')).toBe('user file')
  expect(model.requests).toHaveLength(0)
})

it.each(['workspace', 'session', 'title', 'command'] as const)(
  'launches idempotently with native APIs, resumes %s failure and reads history without running',
  async (stage) => {
    const { ctx, cwd, disposeParent, model } = await setup(
      { emptyReason: true },
      {},
      true,
      1,
      'global',
      false,
    )
    const panel = await mountNative(ctx, cwd)
    await disposeParent()
    expect(ctx.agents.roots()).toHaveLength(0)
    const { randomUUID } = await import('node:crypto'),
      { readdir } = await import('node:fs/promises')
    const input = {
      requestId: randomUUID(),
      rootDir: cwd,
      title: '中文 CON:? 题目',
      goal: '检查空目录并如实保存结果',
    }
    const failed =
      stage === 'workspace'
        ? vi
            .spyOn(ctx.workspaceRegistry, 'create')
            .mockRejectedValueOnce(new Error('temporary failure'))
        : stage === 'session'
          ? vi
              .spyOn(ctx.sessionController, 'create')
              .mockRejectedValueOnce(new Error('temporary failure'))
          : stage === 'title'
            ? vi
                .spyOn(ctx.sessionController, 'rename')
                .mockRejectedValueOnce(new Error('temporary failure'))
            : vi
                .spyOn(panel, 'startNative')
                .mockRejectedValueOnce(new Error('temporary failure'))
    await expect(panel.launch(input)).rejects.toThrow('temporary failure')
    const partial = panel.workbench.snapshot().launches[input.requestId]!
    if (stage !== 'workspace') expect(partial.workspaceId).toBeDefined()
    if (stage === 'title' || stage === 'command')
      expect(partial.sessionId).toBeDefined()
    expect(partial.jobId).toBeUndefined()
    const [one, two] = await Promise.all([
      panel.launch(input),
      panel.launch(input),
    ])
    expect(one).toEqual(two)
    if (partial.sessionId) expect(one.sessionId).toBe(partial.sessionId)
    if (partial.workspaceId) expect(one.workspaceId).toBe(partial.workspaceId)
    expect(failed).toHaveBeenCalledTimes(2)
    expect(
      (await readdir(cwd)).filter((n) => n.startsWith('中文 CON')),
    ).toHaveLength(1)
    await panel.whenIdle(one.cwd)
    await panel.briefs.whenIdle(one.sessionId!)
    const overview = await panel.overview()
    expect(overview).toMatchObject({
      durable: true,
      available: true,
      preferences: { parallelism: 2 },
    })
    const challenge = overview.challenges.find((c) => c.cwd === one.cwd)!
    expect(challenge.phases).toHaveLength(1)
    expect(
      ctx.workspaceRegistry.get(one.workspaceId as never)?.sessionIds,
    ).toContain(one.sessionId)
    const address = {
      workspaceId: one.workspaceId!,
      taskId: challenge.taskId,
      runId: 'r001',
    }
    const before = model.requests.length,
      events = ctx.sessions
        .get(SessionId(one.sessionId!))!
        .snapshotEvents().length
    expect((await panel.detail(address)).address).toEqual(address)
    expect((await panel.node(address, 'f001')).description).toBeTruthy()
    await panel.detail(address)
    await panel.overview()
    await panel.seen(challenge.id)
    await panel.launch(input)
    expect(model.requests).toHaveLength(before)
    expect(
      ctx.sessions.get(SessionId(one.sessionId!))!.snapshotEvents(),
    ).toHaveLength(events)
    await expect(panel.launch({ ...input, goal: 'different' })).rejects.toThrow(
      '同一启动请求',
    )
    await expect(
      panel.detail({ ...address, workspaceId: 'unknown' }),
    ).rejects.toThrow('工作区不存在')
    await expect(
      panel.file(address, '../profile/domains/sapper_workbench.json'),
    ).rejects.toThrow('可预览文件')
  },
)
it('recovers an alpha.13 launch blocked by missing commands after cold restart without duplicating its directory, workspace or session', async () => {
  const first = await setup({ emptyReason: true }, {}, false, 1, 'global', false),
    panel = await mountNative(first.ctx, first.cwd),
    { randomUUID } = await import('node:crypto'),
    { readdir } = await import('node:fs/promises'),
    input = { requestId: randomUUID(), rootDir: first.cwd, title: 'try it 中文', goal: 'Check an empty directory' }
  await expect(panel.launch(input)).rejects.toThrow('DSH 命令服务尚未就绪')
  const partial = panel.workbench.snapshot().launches[input.requestId]!
  expect(partial.sessionId).toBeTruthy()
  expect(partial.workspaceId).toBeTruthy()
  expect(partial.jobId).toBeUndefined()
  expect(first.model.requests).toHaveLength(0)
  await first.ctx.fiber.dispose()
  const second = await setup({ emptyReason: true }, {}, true, 1, 'global', false),
    restored = await mountNative(second.ctx, first.cwd)
  const [one, two] = await Promise.all([restored.launch(input), restored.launch(input)])
  expect(one).toEqual(two)
  expect(one.sessionId).toBe(partial.sessionId)
  expect(one.workspaceId).toBe(partial.workspaceId)
  expect(one.cwd).toBe(partial.cwd)
  expect(one.error).toBeUndefined()
  expect((await readdir(first.cwd)).filter((n) => n.startsWith('try it 中文'))).toHaveLength(1)
  await restored.whenIdle(one.cwd)
  await restored.briefs.whenIdle(one.sessionId!)
  expect(restored.workbench.snapshot().jobs[one.jobId!]).toMatchObject({ state: 'failed', result: { errors: [expect.stringContaining('SAPPER_PLANNING_EMPTY')] } })
  const count = second.model.requests.length
  await restored.launch(input)
  expect(second.model.requests).toHaveLength(count)
})
it('keeps two challenges running, queues the third without model requests, applies a lower limit only to later admission and cancels queued work', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { ctx, cwd, parent, model } = await setup(
    {
      beforeRead: async (signal) => {
        await Promise.race([
          gate,
          new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          }),
        ])
      },
    },
    {},
    true,
    1,
    'global',
    false,
  )
  const harness = {
    create: async (
      id: SessionId,
      agentOptions: import('@deepseek-ai/dsh-agent').AgentOptions,
      meta: { cwd: string },
    ) => (await ctx.agents.create({ sessionId: id, agentOptions, meta })).agent,
  }
  const { mkdir } = await import('node:fs/promises')
  const parents = [parent]
  for (let i = 1; i < 4; i++) {
    const dir = path.join(cwd, '题目' + i)
    await mkdir(dir)
    await writeFile(path.join(dir, 'fixture.txt'), 'VERIFIED-LOCAL-7C42\n')
    parents.push(
      await harness.create(
        SessionId('queue-' + i),
        { provider: 'fixture', model: 'fixture-model' },
        { cwd: dir },
      ),
    )
  }
  const panel = ctx.get('sapperPanel') as TaskPanelService
  const accepted = parents.map((p, i) =>
    panel.submit(p, { action: 'start', goal: 'queue test ' + i }),
  )
  await waitForRuntime(() =>
    expect(
      Object.values(panel.workbench.snapshot().jobs).filter(
        (j) => j.state === 'running',
      ),
    ).toHaveLength(2),
  )
  await waitForRuntime(() =>
    expect(
      model.requests.filter((r) =>
        JSON.stringify(r.messages).includes('# Sapper explore'),
      ),
    ).toHaveLength(2),
  )
  expect(
    Object.values(panel.workbench.snapshot().jobs).find(
      (j) => j.id === accepted[2]!.job_id,
    )?.state,
  ).toBe('queued')
  const count = model.requests.length
  await panel.preferences({ rootDir: '', parallelism: 1 })
  expect(
    Object.values(panel.workbench.snapshot().jobs).filter(
      (j) => j.state === 'running',
    ),
  ).toHaveLength(2)
  expect(model.requests.length).toBe(count)
  panel.submit(parents[2]!, { action: 'cancel' })
  await panel.whenIdle(parents[2]!.session.header.cwd!)
  expect(panel.workbench.snapshot().jobs[accepted[2]!.job_id!]?.state).toBe(
    'cancelled',
  )
  await panel.preferences({ rootDir: '', parallelism: 3 })
  await waitForRuntime(() =>
    expect(
      Object.values(panel.workbench.snapshot().jobs).filter(
        (j) => j.state === 'running',
      ),
    ).toHaveLength(3),
  )
  release()
  await Promise.all(
    parents
      .filter((_, i) => i !== 2)
      .map((p) => panel.whenIdle(p.session.header.cwd!)),
  )
  expect(
    model.requests.some((r) =>
      JSON.stringify(r.messages).includes('queue test 2'),
    ),
  ).toBe(false)
})
it('performs only the selected candidate verification despite another ready route and leaves the old run immutable', async () => {
  const { ctx, cwd, parent, store, dispatch, model } = await setup(
    { flag: 'flag{alpha13-local}', proposals: 2 },
    { orchestration: { maxParallel: 2, maxExplore: 2, maxSteps: 2 } },
    true,
  )
  const first = await dispatch(),
    snapshot = await store.readRun(first.id),
    outcome = first.outcomes.find((o) => o.candidate)!
  const panel = ctx.get('sapperPanel') as TaskPanelService,
    before = model.requests.length
  panel.submit(parent, {
    action: 'verify',
    task_id: 'legacy',
    run_id: first.id,
    intent_id: outcome.intent_id,
  })
  await panel.whenIdle(cwd)
  const second = (await store.listRuns()).at(-1)!
  expect(second.children?.map((c) => c.role)).toEqual(['verify'])
  expect(second.outcomes).toHaveLength(1)
  expect(second.outcomes[0]?.state).toBe('confirmed')
  expect(await store.readRun(first.id)).toEqual(snapshot)
  expect(
    model.requests
      .slice(before)
      .filter((r) => !JSON.stringify(r.messages).includes('SAPPER_MAIN_BRIEF'))
      .every((r) => JSON.stringify(r.messages).includes('# Sapper verify')),
  ).toBe(true)
})
it('waits for native DSH child capacity without spending model budget, and admits a waiting exploration after release', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { ctx, cwd, parent, model, read } = await setup(
    {
      proposals: 2,
      beforeRead: async (signal) =>
        Promise.race([
          gate,
          new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          }),
        ]),
    },
    { orchestration: { maxParallel: 2, maxExplore: 2, maxSteps: 2 } },
    true,
    1,
    'global',
    false,
    1,
  )
  const panel = ctx.get('sapperPanel') as TaskPanelService
  panel.submit(parent, { action: 'start', goal: 'Capacity admission fixture' })
  try {
    await waitForRuntime(() => expect(read).toHaveBeenCalledTimes(1))
    const count = model.requests.length
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(model.requests).toHaveLength(count)
  } finally {
    release()
  }
  await panel.whenIdle(cwd)
  expect(
    Object.values(panel.workbench.snapshot().jobs).every(
      (j) => j.state === 'completed',
    ),
  ).toBe(true)
  expect(
    (await panel.state(String(parent.id))).runs[0]?.outcomes.filter(
      (o) => o.state === 'confirmed',
    ),
  ).toHaveLength(2)
})
it('queues the automatic brief behind a busy parent and generates one text-only turn after it becomes idle', async () => {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  let release!: () => void
  const userGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { ctx, cwd, parent } = await setup(
      { userGate },
      {},
      true,
      1,
      'global',
      false,
    ),
    panel = ctx.get('sapperPanel') as TaskPanelService
  parent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'USER_BUSY' }],
      source: { kind: 'user' },
    }),
  )
  await waitForRuntime(() => expect(parent.status).toBe('running'))
  panel.submit(parent, {
    action: 'start',
    goal: 'Background work while parent busy',
  })
  await panel.whenIdle(cwd)
  const briefs = Object.values(panel.workbench.snapshot().briefs)
  expect(briefs).toHaveLength(1)
  expect(briefs[0]?.state).toBe('queued')
  release()
  await parent.whenIdle()
  await panel.briefs.whenIdle(String(parent.id))
  expect(Object.values(panel.workbench.snapshot().briefs)[0]?.state).toBe(
    'completed',
  )
  const count = parent.session
    .snapshotEvents()
    .filter((e) => e.type === 'turn/start').length
  await panel.overview()
  await panel.state(String(parent.id))
  expect(
    parent.session.snapshotEvents().filter((e) => e.type === 'turn/start'),
  ).toHaveLength(count)
})
it('denies an automatic brief attempting to restart orchestration, keeps its result card, then permits tools in ordinary user dialogue', async () => {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm'),
    scenario: Scenario = { summaryAttack: true }
  const { ctx, cwd, parent, read } = await setup(
      scenario,
      {},
      true,
      1,
      'global',
      false,
    ),
    panel = ctx.get('sapperPanel') as TaskPanelService
  panel.submit(parent, { action: 'start', goal: 'Brief isolation fixture' })
  await panel.whenIdle(cwd)
  await panel.briefs.whenIdle(String(parent.id))
  expect(Object.values(panel.workbench.snapshot().jobs)).toHaveLength(1)
  expect(Object.values(panel.workbench.snapshot().briefs)[0]?.state).toBe(
    'failed',
  )
  expect(
    parent.session
      .snapshotEvents()
      .some((e) => resultOfEvent(e)?.phase === 'result'),
  ).toBe(true)
  const before = read.mock.calls.length
  scenario.summaryAttack = false
  scenario.userRead = true
  parent.followup(
    createUserMessage({
      content: [
        { type: 'text', text: 'USER_AFTER_BRIEF: please read fixture.txt' },
      ],
      source: { kind: 'user' },
    }),
  )
  await parent.whenIdle()
  expect(read.mock.calls.length).toBe(before + 1)
  scenario.userRead = false
  await panel.retryBrief(Object.values(panel.workbench.snapshot().jobs)[0]!.id)
  await panel.briefs.whenIdle(String(parent.id))
  expect(Object.values(panel.workbench.snapshot().briefs)[0]?.state).toBe(
    'completed',
  )
})
it('prioritizes a real user queued immediately after followup without losing or duplicating the automatic brief', async () => {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { ctx, cwd, parent, model } = await setup(
      { userGate: Promise.resolve() },
      {},
      true,
      1,
      'global',
      false,
    ),
    panel = ctx.get('sapperPanel') as TaskPanelService
  let inserted = false
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (
      agent === parent &&
      message.source.kind === 'sapper-dsh' &&
      message.source.form === 'brief' &&
      !inserted
    ) {
      inserted = true
      parent.followup(
        createUserMessage({
          content: [
            { type: 'text', text: 'USER_BUSY: real user has priority' },
          ],
          source: { kind: 'user' },
        }),
      )
    }
  })
  panel.submit(parent, { action: 'start', goal: 'User priority fixture' })
  await panel.whenIdle(cwd)
  await panel.briefs.whenIdle(String(parent.id))
  const parentRequests = model.requests.filter(
    (r) =>
      !JSON.stringify(r.messages).includes('# Sapper reason') &&
      !JSON.stringify(r.messages).includes('# Sapper explore') &&
      !JSON.stringify(r.messages).includes('# Sapper verify'),
  )
  expect(parentRequests).toHaveLength(2)
  expect(JSON.stringify(parentRequests[0]?.messages)).not.toContain(
    'SAPPER_MAIN_BRIEF',
  )
  expect(JSON.stringify(parentRequests[1]?.messages)).toContain(
    'SAPPER_MAIN_BRIEF',
  )
  expect(Object.values(panel.workbench.snapshot().briefs)[0]?.state).toBe(
    'completed',
  )
})
it('restores queued native challenges after a host restart, marks prior runners interrupted and never replays them', async () => {
  const first = await setup({ hang: true }, {}, true, 1, 'global', false),
    panel = await mountNative(first.ctx, first.cwd),
    { randomUUID } = await import('node:crypto')
  const launches: import('../src/workbench/contracts.js').LaunchRecord[] = []
  for (let i = 0; i < 3; i++)
    launches.push(
      await panel.launch({
        requestId: randomUUID(),
        rootDir: first.cwd,
        title: '重启题目' + i,
        goal: 'Recover queued challenge ' + i,
      }),
    )
  await waitForRuntime(() =>
    expect(
      Object.values(panel.workbench.snapshot().jobs).filter(
        (j) => j.state === 'running',
      ),
    ).toHaveLength(2),
  )
  await waitForRuntime(() =>
    expect(
      first.model.requests.filter((r) =>
        JSON.stringify(r.messages).includes('# Sapper explore'),
      ),
    ).toHaveLength(2),
  )
  expect(panel.workbench.snapshot().jobs[launches[2]!.jobId!]?.state).toBe(
    'queued',
  )
  await first.ctx.fiber.dispose()
  const second = await setup(
      { emptyReason: true },
      {enabled:false},
      true,
      1,
      'global',
      false,
    ),
    restored = await mountNative(second.ctx, first.cwd)
  expect(restored.workbench.snapshot().jobs[launches[2]!.jobId!]?.state).toBe('queued')
  expect(second.model.requests).toHaveLength(0)
  second.setConfig({enabled:true})
  const resolved = await second.ctx.sessionController.resolveAgent(
    SessionId(launches[2]!.sessionId!),
  )
  expect(resolved).not.toHaveProperty('error')
  await waitForRuntime(() =>
    expect(restored.workbench.snapshot().jobs[launches[2]!.jobId!]).toMatchObject({ state: 'failed', result: { errors: [expect.stringContaining('SAPPER_PLANNING_EMPTY')] } }),
  )
  expect(restored.workbench.snapshot().jobs[launches[0]!.jobId!]?.state).toBe(
    'interrupted',
  )
  expect(restored.workbench.snapshot().jobs[launches[1]!.jobId!]?.state).toBe(
    'interrupted',
  )
  expect(
    second.model.requests.filter((r) =>
      JSON.stringify(r.messages).includes('# Sapper reason'),
    ),
  ).toHaveLength(1)
  await restored.briefs.whenIdle(launches[2]!.sessionId!)
  expect(Object.values(restored.workbench.snapshot().briefs)).toHaveLength(1)
})

it.each(['failed','completed'] as const)('does not replay a %s automatic brief left in a restored inbox',async state=>{
  const {createUserMessage}=await import('@deepseek-ai/dsh-llm'),{ctx,parent,model}=await setup({}, {},true,1,'global',false),panel=ctx.get('sapperPanel') as TaskPanelService
  const message=createUserMessage({content:[{type:'text',text:'SAPPER_MAIN_BRIEF old automatic message'}],source:{kind:'sapper-dsh',form:'brief',sections:[]}})
  await panel.workbench.change(d=>{d.briefs.old={jobId:'old',sessionId:String(parent.id),messageId:String(message.id),state}})
  parent.followup(message);await parent.whenIdle()
  expect(model.requests).toHaveLength(0);expect(panel.workbench.snapshot().briefs.old?.state).toBe(state)
})

describe('MCP broker across real AgentLoop and native ToolRuntime', () => {
  it('holds a shared workflow before starting a second child, without spending its model steps', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const name = 'mcp__ida__decompile'
    const scenario: Scenario = { externalName: name, registeredTools: [name], proposals: 2, beforeRead: () => gate }
    const { ctx, dispatch, model, read } = await setup(scenario, { orchestration: { maxExplore: 2, maxSteps: 2, concurrency: 2 } })
    const broker = ctx.get('sapperToolBroker')!
    const pending = dispatch()
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(broker.snapshot().waiting.length).toBeGreaterThan(0))
      const explorerIds = new Set(model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper explore')).map((r) => JSON.stringify(r.messages).match(/Read local fixture \d/)?.[0]))
      expect(explorerIds.size).toBe(1)
    } finally { release() }
    expect((await pending).outcomes.filter((o) => o.state === 'confirmed')).toHaveLength(2)
    expect(broker.snapshot().leases.filter((l) => l.state === 'active')).toEqual([])
  })
  it('coordinates a main-session alias with an occupied child workflow using the same physical backend', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const a = 'mcp__ida__decompile', b = 'mcp__other_ida__decompile'
    const { ctx, parent, dispatch, read } = await setup({ externalName: a, registeredTools: [a, b], beforeRead: () => gate })
    const broker = ctx.get('sapperToolBroker')!
    await broker.configure({ selection: 'all', waitMs: 10000, profiles: [(await import('../src/mcp/contracts.js')).profileSchema.parse({ id: 'ida', label: 'IDA', backendId: 'same-IDA', selectors: ['mcp__ida__*', 'mcp__other_ida__*'] })] }, broker.snapshot().revision)
    const run = dispatch()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    const alias = ctx.tools.execute({ name: b, arguments: { path: 'fixture.txt' }, agent: parent, callId: ToolCallId('alias-direct'), signal: new AbortController().signal })
    try { await vi.waitFor(() => expect(broker.snapshot().waiting.length).toBeGreaterThan(0)); expect(read).toHaveBeenCalledTimes(1) } finally { release() }
    expect((await alias).isError).toBe(false); expect((await run).state).toBe('completed')
    expect(broker.snapshot().receipts.some((r) => r.owner.role === 'main' && r.toolRef.publicName === b)).toBe(true)
  })
  it('drains a canceled native call, quarantines uncertainty and never reassigns it just because a signal aborted', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r }), controller = new AbortController()
    const name = 'mcp__ida__run'
    const { ctx, parent, read } = await setup({ registeredTools: [name], beforeRead: () => gate })
    const broker = ctx.get('sapperToolBroker')!
    const running = ctx.tools.execute({ name, arguments: { path: 'fixture.txt' }, agent: parent, callId: ToolCallId('cancel-running'), signal: controller.signal })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    controller.abort(new Error('user cancelled'))
    expect(broker.snapshot().leases.some((l) => l.state === 'active')).toBe(true)
    const queued = ctx.tools.execute({ name, arguments: { path: 'fixture.txt' }, agent: parent, callId: ToolCallId('after-cancel'), signal: new AbortController().signal })
    await vi.waitFor(() => expect(broker.snapshot().waiting).toHaveLength(1))
    release(); expect((await running).isError).toBe(true)
    await vi.waitFor(() => expect(broker.snapshot().leases.some((l) => l.state === 'quarantined')).toBe(true))
    expect(read).toHaveBeenCalledTimes(1)
    await broker.reset('unclassified:mcp', true)
    expect((await queued).isError).toBe(false); expect(read).toHaveBeenCalledTimes(2)
  })
  it('rechecks final monotonic guards after a queued main call becomes runnable', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r }), name = 'mcp__ida__decompile'
    const { ctx, parent, read } = await setup({ registeredTools: [name], beforeRead: () => gate })
    const broker = ctx.get('sapperToolBroker')!
    const first = ctx.tools.execute({ name, arguments: { path: 'fixture.txt' }, agent: parent, callId: ToolCallId('guard-first'), signal: new AbortController().signal })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    let revoked = false
    ctx.tools.guard((exec) => revoked && String(exec.callId) === 'guard-waiting' ? 'late permission revoked' : undefined)
    const second = ctx.tools.execute({ name, arguments: { path: 'fixture.txt' }, agent: parent, callId: ToolCallId('guard-waiting'), signal: new AbortController().signal })
    await vi.waitFor(() => expect(broker.snapshot().waiting).toHaveLength(1))
    revoked = true; release(); await first
    expect((await second).error?.message).toContain('late permission revoked'); expect(read).toHaveBeenCalledTimes(1)
    expect(broker.snapshot().leases.filter((l) => l.state === 'active')).toEqual([])
  })
  it('performs a real native identity probe and refuses the business call on target mismatch', async () => {
    const business = 'mcp__ida__decompile', probe = 'mcp__ida__identity'
    const { ctx, dispatch, read } = await setup({ externalName: business, registeredTools: [business] })
    const checked = vi.fn(async () => ({ database: 'wrong-target' }))
    ctx.tools.register(defineTool({ name: probe, description: 'Identity fixture', parameters: {}, output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] }, execute: checked }))
    const broker = ctx.get('sapperToolBroker')!, { brokerPolicySchema } = await import('../src/mcp/contracts.js')
    await broker.configure(brokerPolicySchema.parse({ profiles: [{ id: 'ida', label: 'IDA', backendId: 'IDA', selectors: ['mcp__ida__*'], identity: { tool: probe, resultPath: 'database', expected: 'right-target' } }] }), broker.snapshot().revision)
    expect((await dispatch()).state).toBe('failed'); expect(checked).toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    expect(broker.snapshot().receipts.some((r) => r.toolRef.publicName === business && r.status === 'error')).toBe(true)
  })
})

it('MCP native-handle factory creates distinct explorer/verifier resources through native policy and confirms their closure', async () => {
  const readName = 'mcp__factory__read', openName = 'mcp__factory__open', verifyName = 'mcp__factory__identity', closeName = 'mcp__factory__close'
  const { ctx, dispatch, cwd, store } = await setup({ externalName: readName, registeredTools: [readName], resourceBindings: true })
  const live = new Set<string>(), created: string[] = [], closed: string[] = []
  const jsonOutput = { schema: { type: 'json' as const }, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] }
  ctx.tools.register(defineTool({ name: openName, description: 'Create independent fixture handle', parameters: {}, output: jsonOutput, execute: async () => { const id = 'handle-' + created.length; created.push(id); live.add(id); return { id, incidental: 'flag{BOOTSTRAP_IS_NOT_TARGET_EVIDENCE}' } } }))
  ctx.tools.register(defineTool({ name: verifyName, description: 'Fixture resource identity', parameters: { session_id: { type: 'string', required: true } }, output: jsonOutput, execute: async (args) => ({ target: live.has(args.session_id) ? cwd : 'closed' }) }))
  ctx.tools.register(defineTool({ name: closeName, description: 'Close owned fixture resource', parameters: { session_id: { type: 'string', required: true } }, output: jsonOutput, execute: async (args) => { live.delete(args.session_id); closed.push(args.session_id); return { closed: true } } }))
  const broker = ctx.get('sapperToolBroker')!, { brokerPolicySchema } = await import('../src/mcp/contracts.js')
  await broker.configure(brokerPolicySchema.parse({ profiles: [{ id: 'factory', label: 'Native handle', backendId: 'factory', selectors: ['mcp__factory__*'], isolation: 'explicit-handle', providerId: 'native-handle', maxInstances: 2,
    native: { open: { tool: openName }, close: { tool: closeName, arguments: { session_id: '{{session}}' } }, verify: { tool: verifyName, arguments: { session_id: '{{session}}' } }, handlePath: 'id', argumentPath: 'session_id', identityPath: 'target', closeConfirmedPath: 'closed', expectedIdentity: '{{cwd}}', tools: [readName] }, effects: { [readName]: 'read' } }] }), broker.snapshot().revision)
  const run = await dispatch()
  expect(run.state, JSON.stringify(run)).toBe('completed'); expect(run.outcomes[0]?.state).toBe('confirmed')
  expect(created).toHaveLength(2); expect(new Set(created).size).toBe(2); expect(closed.sort()).toEqual(created.sort()); expect(live.size).toBe(0)
  expect(run.flag_observations ?? []).toEqual([])
  expect(run.children?.filter((c) => c.role !== 'reason').every((c) => c.tool_broker?.leases.every((l) => l.state === 'released'))).toBe(true)
  expect((await store.readRun(run.id)).outcomes[0]?.candidate?.evidence[0]?.broker?.target.binding).toBe('attested')
})

it('MCP providers admit two independent instances concurrently and advertise only each instance native tools', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const names = ['mcp__ida__slot0', 'mcp__ida__slot1']
  const { ctx, dispatch, read, model } = await setup({ externalName: 'available-mcp', registeredTools: names, proposals: 2, beforeRead: () => gate }, { orchestration: { maxSteps: 2, maxExplore: 2, concurrency: 2 } })
  const broker = ctx.get('sapperToolBroker')!, { brokerPolicySchema } = await import('../src/mcp/contracts.js')
  const close = vi.fn(async () => {})
  broker.registerProvider('fixture-isolated', { open: async ({ slot, owner, fence }) => ({ resourceId: owner.agentId + ':resource', generation: fence, assurance: 'verified-handle', tools: [names[slot]!], bindings: { path: 'fixture.txt' }, verify: async () => true, close }) })
  await broker.configure(brokerPolicySchema.parse({ profiles: [{ id: 'parallel', label: 'Independent fixture resources', backendId: 'IDA-pool', selectors: ['mcp__ida__*'], isolation: 'explicit-handle', providerId: 'fixture-isolated', maxInstances: 2 }] }), broker.snapshot().revision)
  const pending = dispatch()
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const requests = model.requests.filter((r) => JSON.stringify(r.messages).includes('# Sapper explore'))
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(request.tools?.filter((t) => names.includes(t.name))).toHaveLength(1)
  } finally { release() }
  expect((await pending).outcomes.filter((o) => o.state === 'confirmed')).toHaveLength(2)
  expect(close).toHaveBeenCalledTimes(4)
})

it('MCP capacity handoff never holds backend B while its owner waits for the only SDK slot', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r }), names = ['mcp__ida__slot_a', 'mcp__ida__slot_b']
  const { ctx, dispatch, read } = await setup({ externalName: 'available-mcp', registeredTools: names, proposals: 2, capabilitiesByRoute: ['binary.a', 'binary.b'], resourceRequestAfterRead: true, beforeRead: () => gate }, { orchestration: { maxSteps: 2, maxExplore: 2, concurrency: 2 } }, false, 1, 'global', true, 1)
  const broker = ctx.get('sapperToolBroker')!, { brokerPolicySchema } = await import('../src/mcp/contracts.js')
  await broker.configure(brokerPolicySchema.parse({ profiles: names.map((name, i) => ({ id: 'profile-' + i, label: name, backendId: 'backend-' + i, selectors: [name], capabilities: [i ? 'binary.b' : 'binary.a'] })) }), broker.snapshot().revision)
  const pending = dispatch()
  try { await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1)); await vi.waitFor(() => expect(broker.snapshot().leases.some((l) => l.backendId === 'backend-1' && l.state === 'released')).toBe(true)); expect(broker.snapshot().leases.filter((l) => l.backendId === 'backend-1' && l.state === 'active')).toHaveLength(0) } finally { release() }
  const run = await pending
  expect(run.state, JSON.stringify(run)).toBe('completed')
  expect(run.outcomes.filter((o) => o.state === 'confirmed')).toHaveLength(2)
  expect(broker.snapshot().waiting).toEqual([])
})
