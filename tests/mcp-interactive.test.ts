import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { InteractiveSessions } from '../src/mcp/adapters/interactive.js'
import { interactionAdapterSchema, interactionRequestSchema } from '../src/mcp/adapters/interactive-schema.js'
const agent = { id: 'agent', session: { header: { cwd: '/fixture' } } } as Agent
const adapter = interactionAdapterSchema.parse({
  start: { tool: 'mcp__gdb__start' }, read: { tool: 'mcp__gdb__read', arguments: { id: '{{session}}', wait: '{{waitMs}}' } },
  write: { tool: 'mcp__gdb__write', arguments: { id: '{{session}}', data: '{{data}}', encoding: '{{encoding}}' } },
  stop: { tool: 'mcp__gdb__stop', arguments: { id: '{{session}}' } }, sessionPath: 'id', outputPath: 'output', statePath: 'state', stopConfirmsExit: true,
})
const signal = new AbortController().signal
const success = (value: { [k: string]: string }) => ({ isError: false as const, value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const request = (action: string, extra = {}) => interactionRequestSchema.parse({ action, requestId: randomUUID(), ...extra })
it('owns interactive handles, preserves binary pages, and never consumes another reader cursor', async () => {
  const invoke = vi.fn(async (_a, name) => success(name.endsWith('start') ? { id: 'remote-A', output: 'A\u0000中', state: 'stopped' } : { output: '', state: 'awaiting-input' }))
  const sessions = new InteractiveSessions(invoke)
  const started = await sessions.run(agent, request('start', { profileId: 'gdb' }), adapter, signal) as { sessionRef: string; cursor: number }
  expect(started.cursor).toBe(0)
  const read = request('read', { sessionRef: started.sessionRef, cursor: 0, maxBytes: 2 })
  const one = await sessions.run(agent, read, undefined, signal) as { output: { data: string; nextCursor: number; hasMore: boolean } }
  expect(Buffer.from(one.output.data, 'base64')).toEqual(Buffer.from([65, 0])); expect(one.output.hasMore).toBe(true)
  const replay = await sessions.run(agent, request('read', { sessionRef: started.sessionRef, cursor: 0, maxBytes: 2 }), undefined, signal)
  expect(replay).toEqual(one); expect(invoke).toHaveBeenCalledTimes(1)
  const foreign = { ...agent, id: 'foreign' } as Agent
  await expect(sessions.run(foreign, request('read', { sessionRef: started.sessionRef }), undefined, signal)).rejects.toThrow('不属于')
  await expect(sessions.run(agent, request('read', { sessionRef: started.sessionRef, cursor: 999 }), undefined, signal)).rejects.toThrow('CURSOR_EXPIRED')
  await sessions.close(String(agent.id), signal, invoke)
})
it('deduplicates an uncertain write without retransmitting and rejects request-ID reuse with other bytes', async () => {
  const invoke = vi.fn(async (_a, name) => name.endsWith('write') ? { isError: true as const, error: { message: 'network disconnected', name: 'Error', code: 'DISCONNECTED' }, content: [] } : success({ id: 'remote', output: '', state: 'running' }))
  const sessions = new InteractiveSessions(invoke)
  const { sessionRef } = await sessions.run(agent, request('start', { profileId: 'gdb' }), adapter, signal) as { sessionRef: string }
  const write = request('write', { sessionRef, data: 'AAE=', encoding: 'base64' })
  await expect(sessions.run(agent, write, undefined, signal)).rejects.toThrow('DELIVERY_UNKNOWN')
  await expect(sessions.run(agent, write, undefined, signal)).rejects.toThrow('DELIVERY_UNKNOWN')
  expect(invoke.mock.calls.filter((call) => call[1].endsWith('write'))).toHaveLength(1)
  await expect(sessions.run(agent, { ...write, data: 'AAI=' }, undefined, signal)).rejects.toThrow('不得更改')
  await sessions.close(String(agent.id), signal, invoke)
})
it('distinguishes empty output from EOF and refuses to certify an unacknowledged stop', async () => {
  const weak = { ...adapter, stopConfirmsExit: false }
  const invoke = vi.fn(async (_a, name) => success({ id: 'remote', output: '', state: name.endsWith('start') ? 'running' : 'awaiting-input' }))
  const sessions = new InteractiveSessions(invoke)
  const { sessionRef } = await sessions.run(agent, request('start', { profileId: 'gdb' }), weak, signal) as { sessionRef: string }
  expect(await sessions.run(agent, request('read', { sessionRef }), undefined, signal)).toMatchObject({ state: 'awaiting-input', output: { data: '' } })
  await expect(sessions.run(agent, request('stop', { sessionRef }), undefined, signal)).rejects.toThrow('未确认退出')
  expect(await sessions.close(String(agent.id), signal, invoke)).toHaveLength(1)
})
