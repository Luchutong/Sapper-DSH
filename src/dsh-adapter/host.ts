import { ToolBroker } from '../mcp/broker.js'
import { brokerTools } from '../mcp/tools.js'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from './message.js'
import type { Config } from '../settings.js'
import { IDA_METADATA_TOOL, PLUGIN_NAME } from '../constants.js'
import { resolveSelectedStore } from '../store/tasks.js'
import { readProjectSummary } from '../store/project.js'
import { renderProjectContext } from '../render/context.js'
import { createGraphTools, isMutation, requiresExplicitApproval } from '../tools/graph.js'
import { hasFullAccess, writePermission } from './permissions.js'
import { id, StoreError } from '../store/validation.js'
import { GraphStore } from '../store/graph.js'
import { createRecallTools } from '../tools/recall.js'
import { KnowledgeBase } from '../kb/index.js'
import { recallGraph } from '../recall/index.js'
import { renderGraphContext } from '../render/snapshot.js'
import { registerSapperCommand } from './commands.js'
import { Orchestrator } from '../orchestration/engine.js'
import { createDispatchTool } from '../tools/dispatch.js'
import { createTaskTool } from '../tools/task.js'
import { createControlTool } from '../tools/control.js'
import { registerTaskPanel } from './panel.js'
import { createIdaMetadataTool } from './ida-skill.js'

function isOwnSnapshot(message: unknown): boolean {
  const source = (message as UserMessage).source
  return source.kind === PLUGIN_NAME && source.form === 'snapshot'
}

export function registerRuntime(ctx: Context, getConfig: () => Config): void {
  let alive = true
  const bindings = new Map<symbol, { config: string; cwd: string | undefined; root?: string | undefined; permission?: string }>()
  ctx.effect(() => () => { alive = false; bindings.clear() })
  const ensureBinding = (exec: ToolExecution) => {
    if (!alive || !getConfig().enabled) throw new StoreError('Sapper 已关闭或卸载')
    const binding = bindings.get(exec.token)
    if (!binding || binding.config !== JSON.stringify(getConfig()) || binding.cwd !== exec.agent?.session.header.cwd) {
      throw new StoreError('Sapper 配置或工作区在调用期间发生变化，请重新发起调用')
    }
    return binding
  }
  const authorize = (exec: ToolExecution, root: string) => {
    const binding = ensureBinding(exec)
    if (binding.root !== root) throw new StoreError('当前任务在调用期间已切换；请重新发起写入')
    const permission = writePermission(ctx, exec, root)
    if (binding.permission !== permission.fingerprint) throw new StoreError('DSH 会话文件权限已变化，原写入已取消')
    return permission.fullAccess
  }
  const fullAccess = (exec: Pick<ToolExecution, 'agent'>) => hasFullAccess(ctx, exec)
  const broker = ctx.get('sapperToolBroker') ?? new ToolBroker(ctx, () => alive && getConfig().enabled && getConfig().mcpMode === 'legacy', () => getConfig().mcpMode === 'skill')
  const taskPanel = registerTaskPanel(ctx, getConfig, () => alive)
  const dispatcher = new Orchestrator(ctx, getConfig, () => alive, async (parent, root, run, stage) => { try { await taskPanel.progress(parent, root, run, stage) } catch (error) { ctx.logger.warn('Sapper 进度回传失败：%s', (error as Error).message) } }, broker)
  const dispatching = new Set<symbol>()
  const lifecycle = {
    start: (exec: ToolExecution) => { dispatching.add(exec.token); taskPanel.executionStarted(exec) }, finish: (exec: ToolExecution) => { dispatching.delete(exec.token); bindings.delete(exec.token); taskPanel.executionFinished(exec) },
  }
  const tools = [...createGraphTools(getConfig, () => alive, authorize, fullAccess), ...createRecallTools(getConfig, () => alive),
    createDispatchTool(getConfig, () => alive, authorize, dispatcher, lifecycle), createTaskTool(getConfig, () => alive, authorize, dispatcher, lifecycle, (exec) => taskPanel.native.attachmentContext(String(exec.callId), String(exec.agent?.id), exec.agent?.session.header.cwd ?? '')), createControlTool(taskPanel)]
  const legacyTools = brokerTools(broker)
  const idaTool = createIdaMetadataTool(ctx, getConfig)
  const syncCommand = registerSapperCommand(ctx, getConfig, () => alive, taskPanel)
  const kb = new KnowledgeBase()
  let unregister: (() => void) | undefined
  let unregisterMode: (() => void) | undefined
  let mode: Config['mcpMode'] | undefined
  const syncTool = () => {
    if (getConfig().enabled && !unregister) {
      const disposers = tools.map(tool => ctx.tools.register(tool))
      unregister = () => { for (const dispose of disposers.reverse()) dispose() }
    }
    if (!getConfig().enabled && unregister) {
      unregister()
      unregister = undefined
    }
    const nextMode = getConfig().enabled ? getConfig().mcpMode : undefined
    if (mode !== nextMode) {
      unregisterMode?.()
      unregisterMode = undefined
      mode = nextMode
      if (mode) {
        const disposers = (mode === 'legacy' ? legacyTools : [idaTool]).map(tool => ctx.tools.register(tool))
        unregisterMode = () => { for (const dispose of disposers.reverse()) dispose() }
      }
    }
    syncCommand()
  }
  syncTool()
  ctx.on('loader/volatile-update', syncTool)

  ctx.tools.guard(exec => {
    if (!tools.some(tool => tool.name === exec.name) && !legacyTools.some(tool => tool.name === exec.name) && exec.name !== IDA_METADATA_TOOL) return
    try {
      ensureBinding(exec)
      if (isMutation(exec.name, exec.arguments)) {
        const root = bindings.get(exec.token)?.root
        if (!root) throw new StoreError('图写入需要绝对工作区路径')
        authorize(exec, root)
      }
      return undefined
    } catch (error) { return (error as Error).message }
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const roleDenial = dispatcher.denial(exec)
    if (roleDenial) return { kind: 'deny', reason: roleDenial }
    if (!tools.some(tool => tool.name === exec.name) && !legacyTools.some(tool => tool.name === exec.name) && exec.name !== IDA_METADATA_TOOL) return next()
    const binding: { config: string; cwd: string | undefined; root?: string | undefined; permission?: string } = {
      config: JSON.stringify(getConfig()), cwd: exec.agent?.session.header.cwd,
    }
    binding.root = await resolveSelectedStore(binding.cwd, getConfig())
    bindings.set(exec.token, binding)
    if (isMutation(exec.name, exec.arguments)) {
      try {
        const root = binding.root
        if (!root) throw new StoreError('图写入需要绝对工作区路径')
        binding.permission = writePermission(ctx, exec, root).fingerprint
      } catch (error) { return { kind: 'deny', reason: (error as Error).message } }
    }
    const decision = await next()
    if (decision.kind !== 'allow' || !isMutation(exec.name, exec.arguments)) return decision
    try {
      const root = binding.root
      if (!root || !binding.cwd) throw new StoreError('图写入需要绝对工作区路径')
      const fullAccess = authorize(exec, root)
      if (requiresExplicitApproval(exec.name, exec.arguments)) {
        const args = exec.arguments as Record<string, unknown>
        const intent = await new GraphStore(root, binding.cwd).readNode('intent', id(args.id, 'intent'))
        if (intent.to !== null || !intent.requires_confirmation || (intent.confirmed_at && !fullAccess)) {
          return { kind: 'deny', reason: '该意图无需人工确认、已经确认或已结案' }
        }
      }
    } catch (error) { return { kind: 'deny', reason: (error as Error).message } }
    const dispatchApproval = (exec.name === 'sapper_dispatch' || exec.name === 'sapper_task') && getConfig().orchestration.requireApproval
    if (hasFullAccess(ctx, exec) || (getConfig().store.approval !== 'always' && !requiresExplicitApproval(exec.name, exec.arguments) && !dispatchApproval)) return decision
    return { kind: 'ask', reason: `Sapper workspace write: ${exec.name}`,
      displayReason: { en: 'Allow Sapper to modify the current workspace graph?', zh: '允许 Sapper 修改当前工作区的事实图？' } }
  })
  ctx.on('tools/result', exec => { if (!dispatching.has(exec.token)) bindings.delete(exec.token) })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    const messages = decision.messages.filter(message => !isOwnSnapshot(message))
    if (dispatcher.isChild(payload.agent)) return { ...decision, messages }
    const config = getConfig()
    if (!config.enabled || !config.context.inject || messages.length === 0) return { ...decision, messages }
    try {
      const root = await resolveSelectedStore(payload.agent.session.header.cwd, config)
      if (!root) return { ...decision, messages }
      const cwd = payload.agent.session.header.cwd
      const store = new GraphStore(root, cwd)
      if (!await store.initialized()) return { ...decision, messages }
      let text: string
      try {
        const graph = await store.read()
        const query = [...messages].reverse().find(message => message.source.kind === 'user')?.content
          .filter(block => block.type === 'text').map(block => block.text).join(' ').slice(0, 2000) ?? graph.project.goal
        const extras = {
          fullAccess: fullAccess({ agent: payload.agent }), actor: String(payload.agent.id),
          recall: config.context.recallAuto && config.context.scope !== 'goal-only' ? recallGraph(graph, query, config.context.recallTopK) : [],
        }
        let knowledge: ReturnType<KnowledgeBase['search']> = []
        if (config.context.scope !== 'goal-only' && config.kb.enabled && config.kb.injectTopK > 0 && query.trim()) {
          try { knowledge = kb.search(await kb.read(cwd, config.kb.customDir), query, config.kb.injectTopK) }
          catch { ctx.logger.warn('Sapper 自定义 KB 无法读取；本轮仅注入图数据。') }
        }
        text = renderGraphContext(graph, config, { ...extras, kb: knowledge }).text
      } catch (error) {
        // Keep the historical two-field M0 fixture readable, without inventing nodes.
        if (!(error as Error).message.includes('M0 最小 fixture')) throw error
        const project = await readProjectSummary(root, cwd)
        text = project ? renderProjectContext(project, config.context.maxChars) : ''
      }
      if (payload.signal.aborted || !alive || !getConfig().enabled || !getConfig().context.inject) return { ...decision, messages }
      if (!text) return { ...decision, messages }
      return {
        ...decision,
        messages: [...messages, createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: PLUGIN_NAME, form: 'snapshot',
            sections: [{ name: 'Sapper', text }],
          },
        })],
      }
    } catch {
      ctx.logger.warn('Sapper 无法读取当前工作区的项目摘要；请调用 sapper_status 查看错误。')
      return { ...decision, messages }
    }
  })
}
