import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { StoreError } from '../store/validation.js'

export function hasFullAccess(ctx: Context, exec: Pick<ToolExecution, 'agent'>): boolean {
  const service = ctx.get('sandboxPolicy')
  return !!service && !!exec.agent && service.resolve({ session: exec.agent.session }).mode === 'danger-full-access'
}

/** Resolve the standing session grant; never manufacture an escalation. */
export function writePermission(ctx: Context, exec: Pick<ToolExecution, 'agent'>, root: string): { fingerprint: string; fullAccess: boolean } {
  const service = ctx.get('sandboxPolicy')
  if (!service || !exec.agent) throw new StoreError('无法读取 DSH 会话文件权限；图写入已停止')
  const policy = service.resolve({ session: exec.agent.session })
  if (policy.mode === 'read-only') throw new StoreError('当前 DSH 会话为只读，不能写入事实图；请由用户切换会话写权限')
  if (policy.mode !== 'workspace-write' && policy.mode !== 'danger-full-access') throw new StoreError('无法识别 DSH 会话文件权限')
  if (!path.isAbsolute(policy.workspaceRoot)) throw new StoreError('DSH 工作区边界无效')
  const boundary = path.resolve(policy.workspaceRoot)
  const relative = path.relative(boundary, root)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StoreError('事实图路径不在 DSH 会话工作区内')
  }
  return { fingerprint: JSON.stringify({ mode: policy.mode, root: boundary, session: policy.sessionId ?? null }), fullAccess: policy.mode === 'danger-full-access' }
}
