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
import { writePermission } from './permissions.js'
import { id, StoreError } from '../store/validation.js'
import { GraphStore } from '../store/graph.js'

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
    if (binding.permission !== writePermission(ctx, exec, root)) throw new StoreError('DSH 会话文件权限已变化，原写入已取消')
  }
  const tools = createGraphTools(getConfig, () => alive, authorize)
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
        binding.permission = writePermission(ctx, exec, root)
      } catch (error) { return { kind: 'deny', reason: (error as Error).message } }
    }
    const decision = await next()
    if (decision.kind !== 'allow' || !isMutation(exec.name, exec.arguments)) return decision
    try {
      const root = resolveStorePath(binding.cwd, getConfig())
      if (!root || !binding.cwd) throw new StoreError('图写入需要绝对工作区路径')
      authorize(exec, root)
      if (requiresExplicitApproval(exec.name, exec.arguments)) {
        const args = exec.arguments as Record<string, unknown>
        const intent = await new GraphStore(root, binding.cwd).readNode('intent', id(args.id, 'intent'))
        if (intent.to !== null || !intent.requires_confirmation || intent.confirmed_at) {
          return { kind: 'deny', reason: '该意图无需人工确认、已经确认或已结案' }
        }
      }
    } catch (error) { return { kind: 'deny', reason: (error as Error).message } }
    if (getConfig().store.approval !== 'always' && !requiresExplicitApproval(exec.name, exec.arguments)) return decision
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
      const project = await readProjectSummary(root, payload.agent.session.header.cwd)
      if (!project || payload.signal.aborted || !getConfig().enabled || !getConfig().context.inject) return { ...decision, messages }
      const text = renderProjectContext(project, config.context.maxChars)
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
