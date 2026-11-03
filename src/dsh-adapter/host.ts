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
import { createStatusTool } from '../tools/status.js'

function isOwnSnapshot(message: unknown): boolean {
  const source = (message as UserMessage).source
  return source.kind === PLUGIN_NAME && source.form === 'snapshot'
}

export function registerRuntime(ctx: Context, getConfig: () => Config): void {
  const tool = createStatusTool(getConfig)
  let unregister: (() => void) | undefined
  const syncTool = () => {
    if (getConfig().enabled && !unregister) unregister = ctx.tools.register(tool)
    if (!getConfig().enabled && unregister) {
      unregister()
      unregister = undefined
    }
  }
  syncTool()
  ctx.on('loader/volatile-update', syncTool)

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    const messages = decision.messages.filter(message => !isOwnSnapshot(message))
    const config = getConfig()
    if (!config.enabled || !config.context.inject || messages.length === 0) return { ...decision, messages }
    try {
      const root = resolveStorePath(payload.agent.session.header.cwd, config)
      if (!root) return { ...decision, messages }
      const project = await readProjectSummary(root)
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
