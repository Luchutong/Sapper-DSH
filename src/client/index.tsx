import { useState, useSyncExternalStore } from 'react'
import type { BrowserContext, BrowserSettingsScope } from '../dsh-adapter/client.js'
import { GraphPreview } from './graph.js'
import { TaskPanel } from './task-panel.js'
import { PANEL_REMOTE, type PanelApi } from '../panel/rpc.js'
import { VERSION } from '../constants.js'

export const name = 'sapper-dsh'
export const inject = ['slots', 'configForms', 'remote']

export function SapperSettings({ scope }: { scope: BrowserSettingsScope }) {
  const state = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const enabled = typeof state.value === 'object' && state.value !== null &&
    'enabled' in state.value && state.value.enabled === true
  const storeValue = typeof state.value === 'object' && state.value !== null && 'store' in state.value ? state.value.store : null
  const approval = typeof storeValue === 'object' && storeValue !== null && 'approval' in storeValue && storeValue.approval === 'always' ? 'always' : 'session'

  const save = async (path: string[], value: boolean | string) => {
    setPending(true)
    setError('')
    try {
      const accepted = path.length === 1 ? await scope.set(path[0]!, value)
        : await scope.mutate([{ op: 'set', path, value }])
      if (!accepted) {
        setError('DSH 未接受此次保存。请重新加载设置，确认是否有其他窗口修改了配置。')
      }
    } catch {
      setError('保存失败。请重新加载设置，确认是否有其他窗口修改了配置。')
    } finally {
      setPending(false)
    }
  }

  return <section aria-label="Sapper 设置" style={{ padding: 16, maxWidth: 720, overflowWrap: 'anywhere', color: 'inherit' }}>
    <h3>Sapper <small>{VERSION}</small></h3>
    <p>工作区事实图与任务规划</p>
    <label>
      <input type="checkbox" checked={enabled}
        disabled={state.status !== 'ready' || !state.writable || pending}
        onChange={event => { void save(['enabled'], event.target.checked) }} />{' '}
      启用 Sapper
    </label>
    <label style={{ display: 'block', marginTop: 12 }}>
      图写入确认{' '}
      <select aria-label="图写入确认" value={approval}
        disabled={state.status !== 'ready' || !state.writable || pending}
        onChange={event => { void save(['store', 'approval'], event.target.value) }}>
        <option value="session">跟随会话权限（自动）</option>
        <option value="always">受限模式下每次确认</option>
      </select>
    </label>
    <p>完全权限会自动通过 Sapper 的确认门；工作区写入模式保留显式确认点。只读会话不写入，数据始终限于当前工作区。</p>
    <p role="status">{state.status === 'ready'
      ? (enabled ? '已启用：提供事实图存储工具与目标摘要。' : '已关闭：工具和上下文注入均不生效。')
      : '正在等待 DSH 的 sapper 配置表单；不会自动写入默认值。'}</p>
    {error && <p role="alert">{error}</p>}
    <details>
      <summary>开发进度</summary>
      <p>任务面板可发起、继续与取消编排；完整图编辑器及其余高级设置仍在后续阶段。</p>
      <GraphPreview />
    </details>
  </section>
}

export function apply(ctx: BrowserContext): void {
  const scope = ctx.configForms.get('sapper')
  const remote = ctx.remote
  let ready: Promise<unknown> = Promise.resolve()
  let api: PanelApi | undefined
  if (remote) {
    ready = remote.$mount(PANEL_REMOTE)
    ctx.effect(() => { let disposed = false, off: (() => void) | undefined; void ready.then(value => { off = value as () => void; if (disposed) off() }).catch(() => {}); return () => { disposed = true; off?.() } })
    const invoke = async (method: string, input: object) => {
      await ready
      const result = await PANEL_REMOTE.methods['sapperPanel/' + method]!.invoke(remote, input)
      if (!('ok' in result)) throw new Error('任务面板收到意外的流式结果')
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    api = { targets: () => invoke('targets', {}) as ReturnType<PanelApi['targets']>, state: sessionId => invoke('state', { sessionId }) as ReturnType<PanelApi['state']>, action: (sessionId, input) => invoke('action', { sessionId, input }) }
    const panelApi = api
    ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'sapper-task', label: 'Sapper 任务', order: 90 },
      ({ sessionId }) => <details style={{ width: '100%' }}><summary style={{ cursor: 'pointer' }}>Sapper 任务</summary><TaskPanel api={panelApi} {...(sessionId ? { sessionId } : {})} /></details>)))
  }
  const Panel = ({ view }: { view?: string }) => view === 'summary'
    ? <p>工作区事实图与任务规划</p>
    : <>{api && <TaskPanel api={api} />}<SapperSettings scope={scope} /></>
  ctx.effect(() => ctx.configForms.whileServed(['sapper'], () => {
    const offCard = ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item', id: 'sapper', label: 'Sapper', order: 100,
    }, Panel))
    const offSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'sapper', label: 'Sapper', order: 100,
    }, Panel))
    return () => { offSettings(); offCard() }
  }), 'sapper: configuration pages')
}
