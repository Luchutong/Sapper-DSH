import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { SapperSettings } from '../src/client/index.js'
import type { BrowserSettingsScope } from '../src/dsh-adapter/client.js'
import type { Capabilities } from '../src/panel/capabilities.js'
import { EXPLORE_TOOLS } from '../src/orchestration/tool-policy.js'

const catalog: Capabilities = {
  sessions: [{ id: 'main', cwd: '/contest/repeater' }], currentModel: { provider: 'fixture', model: 'model', reasoningEffort: 'opaque-max' }, warnings: [],
  tools: [{ name: 'read', description: 'Read files', available: true, explore: true, verify: true },
    { name: 'mcp__ida__decompile', prefix: 'mcp__ida__*', description: 'IDA 反编译', available: true, explore: true, verify: true },
    { name: 'mcp__browser__navigate', prefix: 'mcp__browser__*', description: '浏览器', available: false, explore: false, verify: false }],
  models: [{ provider: 'fixture', id: 'model', name: 'Test', efforts: [{ id: 'opaque-low', name: '低' }, { id: 'opaque-max', name: '最高' }] }],
}
function setup(accepted = true) {
  const state = { status: 'ready' as const, writable: true, value: { enabled: true }, base: {}, user: {}, revision: 0 },
    scope: BrowserSettingsScope = { getSnapshot: () => state, subscribe: () => () => {}, set: vi.fn(async () => accepted), mutate: vi.fn(async () => accepted) },
    api = { capabilities: vi.fn(async (_input: { sessionId?: string }) => catalog) }
  return { scope, api }
}
const button = (view: ReturnType<typeof create>, name: string) => view.root.findAllByType('button').find((b) => b.children.join('') === name)!
it('reads registered capabilities without writes and saves only an explicitly selected explore MCP prefix', async () => {
  const { scope, api } = setup()
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<SapperSettings scope={scope} api={api} />) })
    expect(api.capabilities).toHaveBeenCalledExactlyOnceWith({})
    expect(scope.mutate).not.toHaveBeenCalled()
    await act(async () => { view.root.findByProps({ 'aria-label': 'explore 全部 MCP' }).props.onChange() })
    await act(async () => { view.root.findByProps({ 'aria-label': 'explore mcp__ida__*' }).props.onChange() })
    expect(scope.mutate).not.toHaveBeenCalled()
    await act(async () => { button(view, '保存探索工具范围').props.onClick() })
    expect(scope.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set', path: ['orchestration', 'exploreTools'], value: [...EXPLORE_TOOLS.filter((t) => t !== 'mcp__*'), 'mcp__ida__*'] }])
    expect(view.root.findByProps({ 'aria-label': 'verify 全部 MCP' }).props.checked).toBe(true)
    await act(async () => { view.root.findByProps({ 'aria-label': '检查主会话' }).props.onChange({ target: { value: 'main' } }) })
    expect(api.capabilities).toHaveBeenLastCalledWith({ sessionId: 'main' })
  } finally { await act(async () => view?.unmount()) }
})
it('uses model-owned reasoning choices and persists default, role model and role effort through Config paths', async () => {
  const { scope, api } = setup()
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<SapperSettings scope={scope} api={api} />) })
    const select = view.root.findByProps({ 'aria-label': '默认推理强度' })
    expect(select.findAllByType('option').map((o) => o.props.value)).toEqual(['inherit', 'opaque-low', 'opaque-max'])
    await act(async () => select.props.onChange({ target: { value: 'opaque-max' } }))
    await act(async () => view.root.findByProps({ 'aria-label': 'verify 模型' }).props.onChange({ target: { value: 'fixture:model' } }))
    await act(async () => view.root.findByProps({ 'aria-label': 'verify 推理强度' }).props.onChange({ target: { value: 'opaque-low' } }))
    expect(scope.mutate).toHaveBeenNthCalledWith(1, [{ op: 'set', path: ['orchestration', 'reasoningEffort'], value: 'opaque-max' }])
    expect(scope.mutate).toHaveBeenNthCalledWith(2, [{ op: 'set', path: ['orchestration', 'models', 'verify'], value: 'fixture:model' }])
    expect(scope.mutate).toHaveBeenNthCalledWith(3, [{ op: 'set', path: ['orchestration', 'reasoningEfforts', 'verify'], value: 'opaque-low' }])
  } finally { await act(async () => view?.unmount()) }
})
it('reports failed Config saves without claiming a changed reasoning default', async () => {
  const { scope, api } = setup(false)
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<SapperSettings scope={scope} api={api} />) })
    await act(async () => view.root.findByProps({ 'aria-label': '默认推理强度' }).props.onChange({ target: { value: 'opaque-max' } }))
    expect(view.root.findByProps({ 'aria-label': '默认推理强度' }).props.value).toBe('inherit')
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('未接受此次保存')
  } finally { await act(async () => view?.unmount()) }
})
it('exposes a fast review default and explicitly saves multi-flag and review defaults', async () => {
  const { scope, api } = setup()
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<SapperSettings scope={scope} api={api} />) })
    expect(view.root.findByProps({ 'aria-label': '默认自动复核' }).props.value).toBe('lightweight')
    expect(scope.mutate).not.toHaveBeenCalled()
    await act(async () => view.root.findByProps({ 'aria-label': '默认自动复核' }).props.onChange({ target: { value: 'none' } }))
    await act(async () => view.root.findByProps({ 'aria-label': '默认 flag 策略' }).props.onChange({ target: { value: 'all' } }))
    expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['verification', 'mode'], value: 'none' }])
    expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['flags', 'completion'], value: 'all' }])
  } finally { await act(async () => view?.unmount()) }
})
