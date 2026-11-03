import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import { PLUGIN_NAME, SDK_VERSION, VERSION } from '../constants.js'
import { resolveStorePath } from '../store/paths.js'
import { readProjectSummary } from '../store/project.js'

export function createStatusTool(getConfig: () => Config) {
  return defineTool({
    name: 'sapper_status',
    description: 'Read Sapper plugin readiness and the existing workspace project goal. Read-only M0 probe; graph mutation and dispatch are not available yet.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { type: 'string', required: true },
          version: { type: 'string', required: true },
          sdk: { type: 'string', required: true },
          milestone: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          goal: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const config = getConfig()
      const base = { plugin: PLUGIN_NAME, version: VERSION, sdk: SDK_VERSION, milestone: 'M0-scaffold', enabled: config.enabled }
      if (!config.enabled) return { ...base, state: 'disabled', goal: '', message: 'Sapper 已关闭' }
      const root = resolveStorePath(exec.agent?.session.header.cwd, config)
      if (!root) return { ...base, state: 'unscoped', goal: '', message: '需要带绝对工作区路径的 DSH 会话' }
      const project = await readProjectSummary(root)
      exec.signal.throwIfAborted()
      return {
        ...base,
        state: project?.status ?? 'uninitialized',
        goal: project?.goal ?? '',
        message: '只读探针；建图、节点读写、完整 frontier 与编排将在后续阶段实现',
      }
    },
  })
}
