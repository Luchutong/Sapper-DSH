import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apply, SapperSettings } from '../src/client/index.js'
import type { BrowserContext, BrowserSettingsScope } from '../src/dsh-adapter/client.js'

describe('client M0 entry', () => {
  it('registers a namespace card and tab without writing on open', () => {
    let writes = 0
    const state = { status: 'ready' as const, writable: true, value: { enabled: true } }
    const scope: BrowserSettingsScope = {
      getSnapshot: () => state, subscribe: () => () => {}, set: async () => { writes++ },
    }
    const rows: Array<{ name: string; key?: string; id?: string }> = []
    const ctx: BrowserContext = {
      settingsScope: { bind: spec => { expect(spec.namespace).toBe('sapper'); return scope } },
      slots: {
        inject: (_name, setup) => setup(),
        register: options => { rows.push(options) },
      },
    }
    apply(ctx)
    expect(rows).toMatchObject([
      { name: 'settings.plugin.item', key: 'sapper' },
      { name: 'settings.plugins.tab', id: 'sapper' },
    ])
    expect(renderToStaticMarkup(<SapperSettings scope={scope} />)).toContain('启用 Sapper')
    expect(writes).toBe(0)
  })
})
