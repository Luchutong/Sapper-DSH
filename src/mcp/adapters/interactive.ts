import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { atPath, BrokerError } from '../contracts.js'
import type { InteractionAdapter, InteractionRequest } from './interactive-schema.js'
type NativeInvoke = (agent: Agent, name: string, args: unknown, signal: AbortSignal) => Promise<ToolExecutionResult>
interface InteractiveSession { id: string; agent: Agent; profileId: string; adapter: InteractionAdapter; handle: string; state: string; chunks: Buffer[]; length: number; baseCursor: number; stopped: boolean; chain: Promise<unknown> }
export function substitute(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === 'string') { const match = /^\{\{([A-Za-z]+)\}\}$/.exec(value); return match ? values[match[1]!] ?? '' : value }
  if (Array.isArray(value)) return value.map((v) => substitute(v, values))
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && '$path' in value && Array.isArray(value.$path)) { const parts = value.$path.map((v) => substitute(v, values)); if (!parts.every((p): p is string => typeof p === 'string')) throw new BrokerError('TOOL_ERROR', '$path 只能包含路径字符串'); return path.join(...parts) }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, values)]))
  return value
}
/** Native-tool adapter: no raw socket/gdb process is invented if no adapter exists. */
export class InteractiveSessions {
  private sessions = new Map<string, InteractiveSession>()
  private requests = new Map<string, { digest: string; promise: Promise<unknown> }>()
  constructor(private invoke: NativeInvoke) {}
  private async native(agent: Agent, adapter: InteractionAdapter, action: InteractionRequest['action'], values: Record<string, unknown>, signal: AbortSignal) {
    const operation = adapter[action]
    if (!operation) throw new BrokerError('ADAPTER_UNAVAILABLE', '适配器没有实现 ' + action)
    const result = await this.invoke(agent, operation.tool, substitute(operation.arguments, values), signal)
    if (result.isError) throw new BrokerError(action === 'write' ? 'DELIVERY_UNKNOWN' : 'TOOL_ERROR', result.error.message)
    return result.value
  }
  run(agent: Agent, input: InteractionRequest, adapter: InteractionAdapter | undefined, signal: AbortSignal): Promise<unknown> {
    const key = String(agent.id) + ':' + input.requestId, digest = JSON.stringify(input)
    const old = this.requests.get(key)
    if (old) {
      if (old.digest !== digest) return Promise.reject(new BrokerError('DELIVERY_UNKNOWN', '同一请求 ID 不得更改交互输入'))
      return old.promise
    }
    const promise = this.execute(agent, input, adapter, signal)
    this.requests.set(key, { digest, promise }); void promise.catch(() => {})
    // Do not evict write request IDs during a live workflow: timeout must not replay input.
    return promise
  }
  private async execute(agent: Agent, input: InteractionRequest, adapter: InteractionAdapter | undefined, signal: AbortSignal) {
    if (input.action === 'start') {
      if (!adapter || !input.profileId) throw new BrokerError('ADAPTER_UNAVAILABLE', '请选择已配置交互原生工具映射的资源组')
      const value = await this.native(agent, adapter, 'start', { cwd: agent.session.header.cwd }, signal)
      const handle = atPath(value, adapter.sessionPath)
      if (typeof handle !== 'string' || !handle) throw new BrokerError('TARGET_MISMATCH', '启动结果未包含可验证的交互句柄')
      const session: InteractiveSession = { id: randomUUID(), agent, profileId: input.profileId, adapter, handle, state: 'running', chunks: [], length: 0, baseCursor: 0, stopped: false, chain: Promise.resolve() }
      this.sessions.set(session.id, session); this.append(session, value)
      return { sessionRef: session.id, state: session.state, cursor: session.baseCursor, availableBytes: session.length - session.baseCursor, transcriptTruncated: session.baseCursor > 0 }
    }
    const session = this.sessions.get(input.sessionRef ?? '')
    if (!session || session.agent !== agent) throw new BrokerError('SCOPE_DENIED', '交互句柄不属于当前 Agent')
    const action = async () => {
      signal.throwIfAborted()
      if (session.stopped && !['read', 'snapshot'].includes(input.action)) throw new BrokerError('STALE_EPOCH', '交互会话已经停止')
      if (input.action === 'read' && (input.cursor < session.baseCursor || input.cursor > session.length)) throw new BrokerError('CURSOR_EXPIRED', `游标超出保留范围 ${session.baseCursor}–${session.length}；旧内容请查看原生回执与已保存产物`)
      if (input.action === 'write' && input.data === undefined) throw new BrokerError('TOOL_ERROR', 'write 必须提供 data')
      if (input.action === 'write' && input.encoding === 'base64' && Buffer.from(input.data!, 'base64').toString('base64') !== input.data) throw new BrokerError('TOOL_ERROR', 'base64 输入不是规范编码')
      const before = session.length
      if (!session.stopped && !(input.action === 'read' && input.cursor < session.length)) {
        const value = await this.native(agent, session.adapter, input.action, { session: session.handle, data: input.data, encoding: input.encoding, cursor: input.cursor, waitMs: input.waitMs }, signal)
        this.append(session, value)
        if (input.action === 'stop') { if (!session.stopped && !session.adapter.stopConfirmsExit) throw new BrokerError('RESOURCE_QUARANTINED', '服务只确认接收 stop，未确认退出'); session.stopped = true; session.state = 'eof' }
      }
      const all = Buffer.concat(session.chunks), cursor = input.action === 'read' ? input.cursor : before
      const end = Math.min(all.length, cursor + input.maxBytes), bytes = all.subarray(cursor - session.baseCursor, end - session.baseCursor)
      // Base64 transcript pages preserve byte offsets and arbitrary binary data.
      return { sessionRef: session.id, state: session.state, delivery: input.action === 'write' ? 'accepted' : 'not-applicable', output: { cursor, nextCursor: end, hasMore: end < all.length, encoding: 'base64', data: bytes.toString('base64') } }
    }
    const pending = session.chain.then(action)
    session.chain = pending.catch(() => {})
    return pending
  }
  private append(session: InteractiveSession, value: unknown) {
    const text = atPath(value, session.adapter.outputPath)
    if (typeof text === 'string') {
      if (session.adapter.outputEncoding === 'base64' && Buffer.from(text, 'base64').toString('base64') !== text.replace(/\s/g, '')) throw new BrokerError('TOOL_ERROR', '服务返回的 base64 输出无效')
      const bytes = Buffer.from(text, session.adapter.outputEncoding)
      session.chunks.push(bytes); session.length += bytes.length
      const retained = session.length - session.baseCursor, limit = 8 * 1024 * 1024
      if (retained > limit) { const all = Buffer.concat(session.chunks); session.chunks = [all.subarray(all.length - limit)]; session.baseCursor = session.length - limit }
    }
    const state = session.adapter.statePath ? atPath(value, session.adapter.statePath) : undefined
    if (typeof state === 'string' && ['running', 'stopped', 'awaiting-input', 'eof', 'crashed', 'error'].includes(state)) session.state = state
    if (session.state === 'eof' || session.state === 'crashed') session.stopped = true
  }
  async close(agentId: string, signal: AbortSignal, invoke: NativeInvoke) {
    const failures: Array<{ profileId: string; error: string }> = []
    for (const [id, session] of this.sessions) if (String(session.agent.id) === agentId) {
      await session.chain
      if (!session.stopped) try { const op = session.adapter.stop; const result = await invoke(session.agent, op.tool, substitute(op.arguments, { session: session.handle }), signal); if (result.isError) throw new Error(result.error.message); this.append(session, result.value); if (!session.stopped && !session.adapter.stopConfirmsExit) throw new Error('服务未确认交互进程结束'); session.stopped = true }
      catch (error) { failures.push({ profileId: session.profileId, error: (error as Error).message }) }
      this.sessions.delete(id)
    }
    for (const key of this.requests.keys()) if (key.startsWith(agentId + ':')) this.requests.delete(key)
    return failures
  }
  ownedHandles(agentId: string) { return [...this.sessions.values()].filter((s) => String(s.agent.id) === agentId).map((s) => ({ profileId: s.profileId, handle: s.handle })) }
}
