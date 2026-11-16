import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { atPath, BrokerError, type ResourceInstance, type ResourceProvider } from '../contracts.js'
import { substitute } from './interactive.js'
type Invoke = (agent: Agent, name: string, args: unknown, signal: AbortSignal, purpose: 'identity' | 'cleanup') => Promise<ToolExecutionResult>
/** Adapts an existing MCP's explicit create/verify/close API. Does not invent worker isolation. */
export function nativeHandleProvider(invoke: Invoke): ResourceProvider {
  return { async open({ profile, owner, fence }) {
    const adapter = profile.native
    if (!adapter) throw new BrokerError('ADAPTER_UNAVAILABLE', '未配置原生句柄创建/校验/关闭映射')
    let handle: string | undefined, agent: Agent | undefined
    const bindings: Record<string, string> = {}
    const call = async (op: typeof adapter.open, signal: AbortSignal, purpose: 'identity' | 'cleanup') => {
      if (!agent) throw new BrokerError('ADAPTER_UNAVAILABLE', 'Agent 尚未绑定')
      const result = await invoke(agent, op.tool, substitute(op.arguments, { session: handle, cwd: owner.cwd, taskId: owner.taskId }), signal, purpose)
      if (result.isError) throw new BrokerError('TOOL_ERROR', result.error.message)
      return result.value
    }
    const instance: ResourceInstance = {
      resourceId: 'pending:' + randomUUID(), generation: fence, assurance: 'verified-handle',
      tools: [...new Set([...adapter.tools, adapter.open.tool, adapter.close.tool, adapter.verify.tool])], lifecycleTools: [adapter.open.tool, adapter.close.tool], bindings,
      verify: async (caller, signal) => {
        agent = caller
        if (!handle) {
          const actual = atPath(await call(adapter.open, signal, 'identity'), adapter.handlePath)
          if (typeof actual !== 'string' || !actual) throw new BrokerError('TARGET_MISMATCH', '后端未返回独立资源句柄')
          handle = actual; bindings[adapter.argumentPath] = actual; instance.resourceId = 'native:' + createHash('sha256').update(JSON.stringify([profile.backendId, actual])).digest('hex')
        }
        const expected = adapter.expectedIdentity.replaceAll('{{cwd}}', owner.cwd).replaceAll('{{taskId}}', owner.taskId)
        const matches = atPath(await call(adapter.verify, signal, 'identity'), adapter.identityPath) === expected
        if (matches && /^(sha256:)?[a-f0-9]{64}$/.test(expected)) instance.assetDigests = [expected.startsWith('sha256:') ? expected : 'sha256:' + expected]
        return matches
      },
      close: async (signal) => {
        if (!handle) return
        const result = await call(adapter.close, signal, 'cleanup')
        if (atPath(result, adapter.closeConfirmedPath) !== true) throw new BrokerError('RESOURCE_QUARANTINED', '服务未确认资源已关闭')
        handle = undefined
      },
    }
    return instance
  } }
}
