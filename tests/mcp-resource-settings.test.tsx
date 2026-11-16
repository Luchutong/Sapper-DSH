import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { ResourceSettings } from '../src/client/resource-settings.js'
import { brokerPolicySchema, type BrokerSnapshot } from '../src/mcp/contracts.js'
const state = (): BrokerSnapshot => ({ policy: brokerPolicySchema.parse({}), revision: 3, durable: true, hostInstanceId: 'host', leases: [], waiting: [], owners: [], providers: ['native-handle'], receipts: [], warnings: [] })
const button = (view: ReturnType<typeof create>, text: string) => view.root.findAllByType('button').find((b) => b.children.join('') === text)!
it('only reads on mount, preserves typed comma-separated selectors, and saves through the independent policy RPC', async () => {
  const data = state(), api = { brokerState: vi.fn(async () => data), brokerConfigure: vi.fn(async (input) => ({ ...data, policy: input.policy, revision: 4 })) }
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<ResourceSettings api={api} />) })
    expect(api.brokerConfigure).not.toHaveBeenCalled()
    await act(async () => button(view, '添加资源配置组').props.onClick())
    await act(async () => view.root.findByProps({ 'aria-label': '资源工具范围 0' }).props.onChange({ target: { value: 'mcp__ida__*, ' } }))
    expect(view.root.findByProps({ 'aria-label': '资源工具范围 0' }).props.value).toBe('mcp__ida__*, ')
    await act(async () => view.root.findByProps({ 'aria-label': '资源工具范围 0' }).props.onChange({ target: { value: 'mcp__ida__*, mcp__alias__*' } }))
    await act(async () => view.root.findByProps({ 'aria-label': '资源工具范围 0' }).props.onBlur())
    await act(async () => button(view, '保存资源策略').props.onClick())
    expect(api.brokerConfigure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: 3, policy: expect.objectContaining({ profiles: [expect.objectContaining({ selectors: ['mcp__ida__*', 'mcp__alias__*'], backendId: 'ida-local' })] }) }))
  } finally { await act(async () => view?.unmount()) }
})
it('does not reset quarantine without explicit confirmation of the actual backend state', async () => {
  const data = state(); data.leases.push({ id: 'lease', ownerId: 'agent', key: 'backend:IDA', slot: 0, backendId: 'IDA', fence: 1, epoch: 1, state: 'quarantined', assurance: 'serialized', startedAt: 'now', heartbeatAt: 'now' })
  const api = { brokerState: vi.fn(async () => data), brokerReset: vi.fn(async () => state()) }
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<ResourceSettings api={api} />) })
    expect(button(view, '解除该资源隔离').props.disabled).toBe(true)
    expect(api.brokerReset).not.toHaveBeenCalled()
    await act(async () => view.root.findByProps({ 'aria-label': '确认后端已重置 backend:IDA' }).props.onChange({ target: { checked: true } }))
    await act(async () => button(view, '解除该资源隔离').props.onClick())
    expect(api.brokerReset).toHaveBeenCalledExactlyOnceWith({ key: 'backend:IDA', confirmed: true })
  } finally { await act(async () => view?.unmount()) }
})
it('renders a read-only task resource view without configuration or execution actions', async () => {
  const api = { brokerState: vi.fn(async () => state()), brokerConfigure: vi.fn(), brokerReset: vi.fn() }
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<ResourceSettings api={api} readOnly address={{ workspaceId: 'A', taskId: 't-A' }} />) })
    expect(button(view, '添加资源配置组')).toBeUndefined()
    expect(api.brokerConfigure).not.toHaveBeenCalled(); expect(api.brokerReset).not.toHaveBeenCalled()
  } finally { await act(async () => view?.unmount()) }
})
