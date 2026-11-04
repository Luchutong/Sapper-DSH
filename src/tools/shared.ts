import path from 'node:path'
import type { InferValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import { GraphStore } from '../store/graph.js'
import { resolveSelectedStore } from '../store/tasks.js'
import { StoreError } from '../store/validation.js'

export type AuthorizeWrite = (exec: ToolRunContext, root: string) => boolean

export const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}
export function json(value: unknown): InferValue<typeof output.schema> {
  return JSON.parse(JSON.stringify(value)) as InferValue<typeof output.schema>
}
export async function executionStore(getConfig: () => Config, exec: ToolRunContext, alive: () => boolean = () => true, authorize?: AuthorizeWrite) {
  exec.signal.throwIfAborted()
  const cwd = exec.agent?.session.header.cwd
  const config = getConfig()
  const fingerprint = JSON.stringify(config)
  if (!alive() || !config.enabled) throw new StoreError('Sapper 已关闭或卸载')
  const root = await resolveSelectedStore(cwd, config)
  if (!root || !cwd) throw new StoreError('需要带绝对工作区路径的 DSH 会话')
  return {
    store: new GraphStore(root, path.resolve(cwd)),
    creator: String(exec.agent?.id ?? 'dsh-user'),
    options: {
      signal: exec.signal,
      autoConfirm: () => authorize?.(exec, root) === true,
      guard: () => {
        if (!alive() || !getConfig().enabled || JSON.stringify(getConfig()) !== fingerprint || exec.agent?.session.header.cwd !== cwd) throw new StoreError('插件已关闭或配置/工作区已变化；写入已取消')
        if (!authorize) throw new StoreError('缺少 DSH 图写入权限检查')
        authorize(exec, root)
      },
    },
  }
}
