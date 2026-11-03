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
