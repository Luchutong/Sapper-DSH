import path from 'node:path'
import type { Config } from '../settings.js'

/** Workspace-local graphs; global storage remains reserved. */
export function resolveStorePath(cwd: string | undefined, config: Config): string | undefined {
  if (!cwd || !path.isAbsolute(cwd)) return undefined
  if (config.store.mode !== 'workspace') {
    throw new Error('global 存储尚未开放；当前只支持 workspace 模式')
  }
  const workspace = path.resolve(cwd)
  const resolved = path.resolve(workspace, config.store.dir)
  const relative = path.relative(workspace, resolved)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('store.dir 必须指向工作区内的独立子目录')
  }
  return resolved
}
