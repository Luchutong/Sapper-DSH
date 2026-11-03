import { useState, useSyncExternalStore } from 'react'
import type { BrowserContext, BrowserSettingsScope } from '../dsh-adapter/client.js'
import { GraphPreview } from './graph.js'
import { VERSION } from '../constants.js'

export const name = 'sapper-dsh'
export const inject = ['slots', 'configForms']

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

  const toggle = async (enabled: boolean) => {
    setPending(true)
    setError('')
    try {
      if (!await scope.set('enabled', enabled)) {
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
    <p>工作区记忆与任务规划插件 · M0 骨架</p>
    <label>
      <input type="checkbox" checked={enabled}
        disabled={state.status !== 'ready' || !state.writable || pending}
        onChange={event => { void toggle(event.target.checked) }} />{' '}
      启用 Sapper
    </label>
    <p role="status">{state.status === 'ready'
      ? (enabled ? '已启用：提供只读状态探针与目标摘要注入。' : '已关闭：工具和上下文注入均不生效。')
      : '正在等待 DSH 的 sapper 配置表单；不会自动写入默认值。'}</p>
    {error && <p role="alert">{error}</p>}
    <details>
      <summary>开发进度</summary>
      <p>常规、上下文、编排、知识库和诊断的完整表单计划在 M4 完成。</p>
      <GraphPreview />
    </details>
  </section>
}

export function apply(ctx: BrowserContext): void {
  const scope = ctx.configForms.get('sapper')
  const Panel = ({ view }: { view?: string }) => view === 'summary'
    ? <p>工作区记忆与任务规划插件 · M0 骨架</p>
    : <SapperSettings scope={scope} />
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
