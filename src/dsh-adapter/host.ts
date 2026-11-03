import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from './message.js'
import type { Config } from '../settings.js'
import { PLUGIN_NAME } from '../constants.js'
import { resolveStorePath } from '../store/paths.js'
import { readProjectSummary } from '../store/project.js'
import { renderProjectContext } from '../render/context.js'
import { alwaysApprove, createGraphTools, isMutation } from '../tools/graph.js'

function isOwnSnapshot(message: unknown): boolean {
  const source = (message as UserMessage).source
  return source.kind === PLUGIN_NAME && source.form === 'snapshot'
}

export function registerRuntime(ctx: Context, getConfig: () => Config): void {
  let alive = true
  const bindings = new Map<symbol, { config: string; cwd: string | undefined }>()
  ctx.effect(() => () => { alive = false; bindings.clear() })
  const tools = createGraphTools(getConfig, () => alive)
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
    if (!alive || !getConfig().enabled) return 'Sapper 已关闭或卸载'
    const binding = bindings.get(exec.token)
    if (!binding || binding.config !== JSON.stringify(getConfig()) || binding.cwd !== exec.agent?.session.header.cwd) {
      return 'Sapper 配置或工作区在审批期间发生变化，请重新发起调用'
    }
    return undefined
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!tools.some(tool => tool.name === exec.name)) return next()
    bindings.set(exec.token, { config: JSON.stringify(getConfig()), cwd: exec.agent?.session.header.cwd })
    const decision = await next()
    if (decision.kind !== 'allow' || !isMutation(exec.name, exec.arguments)) return decision
    if (!alive || !getConfig().enabled) return { kind: 'deny', reason: 'Sapper 已关闭或卸载' }
    if (!getConfig().orchestration.requireApproval && !alwaysApprove(exec.name, exec.arguments)) return decision
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
