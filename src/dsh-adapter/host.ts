import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from './message.js'
import type { Config } from '../settings.js'
import { PLUGIN_NAME } from '../constants.js'
import { resolveStorePath } from '../store/paths.js'
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

function isOwnSnapshot(message: unknown): boolean {
  const source = (message as UserMessage).source
  return source.kind === PLUGIN_NAME && source.form === 'snapshot'
}

export function registerRuntime(ctx: Context, getConfig: () => Config): void {
  let alive = true
  const bindings = new Map<symbol, { config: string; cwd: string | undefined; permission?: string }>()
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
    const permission = writePermission(ctx, exec, root)
    if (binding.permission !== permission.fingerprint) throw new StoreError('DSH 会话文件权限已变化，原写入已取消')
    return permission.fullAccess
  }
  const fullAccess = (exec: Pick<ToolExecution, 'agent'>) => hasFullAccess(ctx, exec)
  const tools = [...createGraphTools(getConfig, () => alive, authorize, fullAccess), ...createRecallTools(getConfig, () => alive)]
  const syncCommand = registerSapperCommand(ctx, getConfig, () => alive)
  const kb = new KnowledgeBase()
  let unregister: (() => void) | undefined
  const syncTool = () => {
    if (getConfig().enabled && !unregister) {
      const disposers = tools.map(tool => ctx.tools.register(tool))
      unregister = () => { for (const dispose of disposers.reverse()) dispose() }
    }
    if (!getConfig().enabled && unregister) {
      unregister()
      unregister = undefined
    }
    syncCommand()
  }
  syncTool()
  ctx.on('loader/volatile-update', syncTool)

  ctx.tools.guard(exec => {
    if (!tools.some(tool => tool.name === exec.name)) return
    try {
      ensureBinding(exec)
      if (isMutation(exec.name, exec.arguments)) {
        const root = resolveStorePath(exec.agent?.session.header.cwd, getConfig())
        if (!root) throw new StoreError('图写入需要绝对工作区路径')
        authorize(exec, root)
      }
      return undefined
    } catch (error) { return (error as Error).message }
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!tools.some(tool => tool.name === exec.name)) return next()
    const binding: { config: string; cwd: string | undefined; permission?: string } = {
      config: JSON.stringify(getConfig()), cwd: exec.agent?.session.header.cwd,
    }
    bindings.set(exec.token, binding)
    if (isMutation(exec.name, exec.arguments)) {
      try {
        const root = resolveStorePath(binding.cwd, getConfig())
        if (!root) throw new StoreError('图写入需要绝对工作区路径')
        binding.permission = writePermission(ctx, exec, root).fingerprint
      } catch (error) { return { kind: 'deny', reason: (error as Error).message } }
    }
    const decision = await next()
    if (decision.kind !== 'allow' || !isMutation(exec.name, exec.arguments)) return decision
    try {
      const root = resolveStorePath(binding.cwd, getConfig())
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
    if (hasFullAccess(ctx, exec) || (getConfig().store.approval !== 'always' && !requiresExplicitApproval(exec.name, exec.arguments))) return decision
    return { kind: 'ask', reason: `Sapper workspace write: ${exec.name}`,
      displayReason: { en: 'Allow Sapper to modify the current workspace graph?', zh: '允许 Sapper 修改当前工作区的事实图？' } }
  })
  ctx.on('tools/result', exec => { bindings.delete(exec.token) })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    const messages = decision.messages.filter(message => !isOwnSnapshot(message))
    const config = getConfig()
    if (!config.enabled || !config.context.inject || messages.length === 0) return { ...decision, messages }
    try {
      const root = resolveStorePath(payload.agent.session.header.cwd, config)
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
