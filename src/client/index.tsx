import { useState, useSyncExternalStore } from 'react'
import type { BrowserContext, BrowserSettingsScope } from '../dsh-adapter/client.js'
import { GraphPreview } from './graph.js'
import { VERSION } from '../constants.js'

export const name = 'sapper-dsh'
export const inject = ['slots', 'settingsScope']

export function SapperSettings({ scope }: { scope: BrowserSettingsScope }) {
  const state = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const toggle = async (enabled: boolean) => {
    setPending(true)
    setError('')
    try {
      await scope.set('enabled', enabled)
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
      <input type="checkbox" checked={state.value?.enabled ?? false}
        disabled={state.status !== 'ready' || !state.writable || pending}
        onChange={event => { void toggle(event.target.checked) }} />{' '}
      启用 Sapper
    </label>
    <p role="status">{state.status === 'ready'
      ? (state.value?.enabled ? '已启用：提供只读状态探针与目标摘要注入。' : '已关闭：工具和上下文注入均不生效。')
      : '正在等待 DSH 的 sapper 设置命名空间；不会自动写入默认值。'}</p>
    {error && <p role="alert">{error}</p>}
    <details>
      <summary>开发进度</summary>
      <p>常规、上下文、编排、知识库和诊断的完整表单计划在 M4 完成。</p>
      <GraphPreview />
    </details>
  </section>
}

export function apply(ctx: BrowserContext): void {
  const scope = ctx.settingsScope.bind({ namespace: 'sapper' })
  const Panel = () => <SapperSettings scope={scope} />
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item', key: 'sapper',
  }, Panel))
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'sapper', label: 'Sapper', order: 100,
  }, Panel))
}
