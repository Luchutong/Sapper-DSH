import path from 'node:path'
import type { Config } from '../settings.js'

/** M0 resolves workspace paths only. Global mode needs DSH's data-directory API. */
export function resolveStorePath(cwd: string | undefined, config: Config): string | undefined {
  if (!cwd || !path.isAbsolute(cwd)) return undefined
  if (config.store.mode !== 'workspace') {
    throw new Error('全局存储将在 M1 接入 DSH 数据目录；当前只支持 workspace 模式')
  }
  const workspace = path.resolve(cwd)
  const resolved = path.resolve(workspace, config.store.dir)
  const relative = path.relative(workspace, resolved)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('store.dir 必须指向工作区内的独立子目录')
  }
  return resolved
}
