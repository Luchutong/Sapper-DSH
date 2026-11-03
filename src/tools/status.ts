import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import { PLUGIN_NAME, SDK_VERSION, VERSION } from '../constants.js'
import { executionStore, json, output } from './shared.js'
import { resolveStorePath } from '../store/paths.js'
import { graphStatus } from '../render/status.js'
import { renderGraphView } from '../render/snapshot.js'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

export function createStatusTool(getConfig: () => Config, alive?: () => boolean, fullAccess: (exec: ToolExecution) => boolean = () => false) {
  return defineTool({
    name: 'sapper_status',
    description: 'Read project status, ready/pending/in-flight frontier and integrity diagnostics. view=frontier expands brief intent rows; view=graph renders a bounded graph without doc. Read-only.',
    parameters: { view: { type: 'string', enum: ['summary', 'frontier', 'graph'] } }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const config = getConfig()
      const base = { plugin: PLUGIN_NAME, version: VERSION, sdk: SDK_VERSION, milestone: 'M3-orchestration', enabled: config.enabled, store_approval: config.store.approval }
      if (!config.enabled) return json({ ...base, state: 'disabled', goal: '', message: 'Sapper 已关闭' })
      if (!resolveStorePath(exec.agent?.session.header.cwd, config)) return json({ ...base, state: 'unscoped', goal: '', message: '需要带绝对工作区路径的 DSH 会话' })
      const { store } = executionStore(getConfig, exec, alive)
      await store.checkReadable()
      if (!await store.initialized()) return json({ ...base, state: 'uninitialized', goal: '', message: '请调用 sapper_init 创建事实图；状态查询不会自动创建目录' })
      const graph = await store.read()
      exec.signal.throwIfAborted()
      return json({
        ...base,
        ...graphStatus(graph, { fullAccess: fullAccess(exec), ...(exec.agent ? { actor: String(exec.agent.id) } : {}) }, args.view === 'frontier'),
        ...(args.view === 'graph' ? { graph_text: renderGraphView(graph, config.context.maxChars) } : {}),
        message: 'M2/M3 frontier、recall、KB 与 reason/explore/verify 编排已实现',
      })
    },
  })
}
