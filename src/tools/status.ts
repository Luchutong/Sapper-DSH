import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import { PLUGIN_NAME, SDK_VERSION, VERSION } from '../constants.js'
import { executionStore, json, output } from './shared.js'
import { resolveStorePath } from '../store/paths.js'

export function createStatusTool(getConfig: () => Config, alive?: () => boolean) {
  return defineTool({
    name: 'sapper_status',
    description: 'Read the Sapper project status, node counts and integrity diagnostics without writing any files. Full frontier and recall arrive in M2.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const config = getConfig()
      const base = { plugin: PLUGIN_NAME, version: VERSION, sdk: SDK_VERSION, milestone: 'M1-storage', enabled: config.enabled, store_approval: config.store.approval }
      if (!config.enabled) return json({ ...base, state: 'disabled', goal: '', message: 'Sapper 已关闭' })
      if (!resolveStorePath(exec.agent?.session.header.cwd, config)) return json({ ...base, state: 'unscoped', goal: '', message: '需要带绝对工作区路径的 DSH 会话' })
      const { store } = executionStore(getConfig, exec, alive)
      await store.checkReadable()
      if (!await store.initialized()) return json({ ...base, state: 'uninitialized', goal: '', message: '请调用 sapper_init 创建事实图；状态查询不会自动创建目录' })
      const graph = await store.read()
      exec.signal.throwIfAborted()
      return json({
        ...base,
        state: graph.project.status, goal: graph.project.goal,
        counts: { facts: graph.facts.filter(f => f.id !== 'goal').length, intents: graph.intents.length,
          open_intents: graph.intents.filter(i => i.to === null).length, hints: graph.hints.length, flags: graph.facts.filter(f => f.kind === 'flag').length },
        warnings: graph.warnings, integrity: graph.integrity,
        message: 'M1 存储与六类工具已实现；frontier、recall 与编排属于后续阶段',
      })
    },
  })
}
