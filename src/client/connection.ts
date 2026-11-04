import type { BrowserContext } from '../dsh-adapter/client.js'
import { PANEL_REMOTE, type PanelApi } from '../panel/rpc.js'

export interface ConnectionSnapshot { api?: PanelApi; error?: string }
export function connectPanel(ctx: BrowserContext) {
  let snapshot: ConnectionSnapshot = {}, closed = false, off: (() => void) | undefined
  const listeners = new Set<() => void>()
  const update = (next: ConnectionSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
  const source = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
  if (!ctx.remote) { update({ error: 'DSH Remote 服务尚未就绪' }); return source }
  const mounted = ctx.remote.$mount(PANEL_REMOTE)
  ctx.effect(() => { void mounted.then(dispose => { off = dispose; if (closed) dispose() }).catch(error => update({ error: (error as Error).message })); return () => { closed = true; off?.() } })
  // Cordis namespaces are traced services: injecting `remote` alone grants no namespace access.
  ctx.inject(['remote.sapperPanel'], scoped => {
    const invoke = async (method: string, input: object) => {
      await mounted
      const result = await PANEL_REMOTE.methods['sapperPanel/' + method]!.invoke(scoped.remote!, input)
      if (!('ok' in result)) throw new Error('Sapper 收到非预期流式结果')
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    const api: PanelApi = { targets: () => invoke('targets', {}) as ReturnType<PanelApi['targets']>, state: sessionId => invoke('state', { sessionId }) as ReturnType<PanelApi['state']>, action: (sessionId, input) => invoke('action', { sessionId, input }), report: sessionId => invoke('report', { sessionId }) as ReturnType<NonNullable<PanelApi['report']>> }
    update({ api })
    scoped.effect(() => () => { if (!closed) update({ error: 'Sapper 连接已断开，正在等待服务恢复' }) })
  })
  return source
}
