import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { apply, SapperSettings } from '../src/client/index.js'
import type { BrowserContext, BrowserSettingsScope } from '../src/dsh-adapter/client.js'

function makeScope(accepted = true): BrowserSettingsScope {
  const state = { status: 'ready' as const, writable: true, value: { enabled: true }, base: {}, user: {}, revision: 0 }
  return { getSnapshot: () => state, subscribe: () => () => {}, set: vi.fn(async () => accepted), mutate: vi.fn(async () => accepted) }
}

describe('DSH 0.2 client entry', () => {
  it('registers current plugin/setting slots without writing on open, and disposes them', () => {
    const scope = makeScope()
    const rows: string[] = []
    let cleanup = () => {}
    const disposed: string[] = []
    const ctx: BrowserContext = {
      configForms: {
        get: id => { expect(id).toBe('sapper'); return scope },
        whileServed: (ids, setup) => { expect(ids).toEqual(['sapper']); return setup(new Set(ids)) },
      },
      effect: setup => { cleanup = setup() },
      slots: {
        inject: (_name, setup) => setup(),
        register: options => { rows.push(options.name); return () => { disposed.push(options.name) } },
      },
    }
    apply(ctx)
    expect(rows).toEqual(['plugins.item', 'settings.section'])
    expect(renderToStaticMarkup(<SapperSettings scope={scope} />)).toContain('启用 Sapper')
    expect(scope.set).not.toHaveBeenCalled()
    expect(scope.mutate).not.toHaveBeenCalled()
    cleanup()
    expect(disposed).toEqual(['settings.section', 'plugins.item'])
  })

  it('reports a Host-refused write instead of treating false as a saved setting', async () => {
    const scope = makeScope(false)
    const renderer = create(<SapperSettings scope={scope} />)
    await act(async () => { renderer.root.findByType('input').props.onChange({ target: { checked: false } }) })
    expect(scope.set).toHaveBeenCalledWith('enabled', false)
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('未接受此次保存')
    expect(renderer.root.findByType('input').props.checked).toBe(true)
    renderer.unmount()
  })
  it('exposes automatic storage by default and writes only its nested setting on explicit selection', async () => {
    const scope = makeScope()
    const renderer = create(<SapperSettings scope={scope} />)
    expect(renderer.root.findByType('select').props.value).toBe('session')
    expect(scope.set).not.toHaveBeenCalled()
    await act(async () => { renderer.root.findByType('select').props.onChange({ target: { value: 'always' } }) })
    expect(scope.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set', path: ['store', 'approval'], value: 'always' }])
    expect(scope.set).not.toHaveBeenCalled()
    renderer.unmount()
  })
})

it('submits a goal from the task panel, shows failures, and resumes or cancels without manual graph tools', async () => {
  const { TaskPanel } = await import('../src/client/task-panel.js')
  const data: import('../src/panel/rpc.js').PanelState = { cwd: '/ordinary project', active: 'legacy', tasks: [], runs: [] }
  const api = { targets: vi.fn(async () => [{ id: 'session-1', cwd: '/ordinary project' }]), state: vi.fn(async () => ({ ...data })), action: vi.fn(async (_session: string, input: import('../src/panel/rpc.js').PanelAction) => {
    if (input.action === 'start') Object.assign(data, { job: { state: 'running', started_at: 'now' } })
    if (input.action === 'cancel') Object.assign(data, { job: { state: 'cancelled', started_at: 'now' }, graph: { goal: 'Check files', status: 'active', facts: 1, verified: 0, ready: 1, integrity: [] } })
  }) }
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<TaskPanel api={api} />) })
  await act(async () => { renderer.root.findByType('textarea').props.onChange({ target: { value: 'Check files' } }) })
  await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, stopPropagation() {} }) })
  expect(api.action).toHaveBeenCalledWith('session-1', { action: 'start', goal: 'Check files' })
  expect(renderer.root.findByType('textarea').props.disabled).toBe(false)
  await act(async () => { renderer.root.findByType('textarea').props.onChange({ target: { value: 'Draft next task while the first runs' } }) })
  expect(renderer.root.findByType('textarea').props.value).toBe('Draft next task while the first runs')
  expect(renderer.root.findByProps({ type: 'submit' }).props.disabled).toBe(true)
  const button = (label: string) => renderer.root.findAllByType('button').find(b => b.children.join('') === label)!
  await act(async () => { button('取消任务').props.onClick() })
  expect(api.action).toHaveBeenLastCalledWith('session-1', { action: 'cancel' })
  expect(button('继续当前任务')).toBeDefined()
  api.action.mockRejectedValueOnce(new Error('只读会话不能写入'))
  await act(async () => { button('继续当前任务').props.onClick() })
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('只读会话')
  await act(async () => { renderer.unmount() })
})

it('reveals a command-launched job in the dock and keeps a user-closed dock closed until the next job', async () => {
  const { TaskDock } = await import('../src/client/task-panel.js')
  vi.useFakeTimers()
  let renderer!: ReturnType<typeof create>
  let job = { id: 'first-job', state: 'running' as const, started_at: 'first' }
  const api = { targets: async () => [{ id: 'session-1', cwd: '/ordinary project' }], state: async () => ({ cwd: '/ordinary project', active: 'legacy', tasks: [], runs: [], job }), action: async () => ({ accepted: true }) }
  try {
    await act(async () => { renderer = create(<TaskDock api={api} sessionId="session-1" />) })
    expect(renderer.root.findByType('details').props.open).toBe(true)
    await act(async () => { renderer.root.findByType('details').props.onToggle({ currentTarget: { open: false } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(renderer.root.findByType('details').props.open).toBe(false)
    job = { id: 'second-job', state: 'running', started_at: 'second' }
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(renderer.root.findByType('details').props.open).toBe(true)
  } finally { await act(async () => { renderer?.unmount() }); vi.useRealTimers() }
})
