import type { BrowserContext } from '../dsh-adapter/client.js'
import { PANEL_REMOTE, type WorkbenchPanelApi } from '../panel/rpc.js'

export interface ConnectionSnapshot {
  api?: WorkbenchPanelApi
  error?: string
}
export function connectPanel(ctx: BrowserContext) {
  let snapshot: ConnectionSnapshot = {},
    closed = false,
    off: (() => void) | undefined
  const listeners = new Set<() => void>()
  const update = (next: ConnectionSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const source = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  if (!ctx.remote) {
    update({ error: 'DSH Remote 服务尚未就绪' })
    return source
  }
  const mounted = ctx.remote.$mount(PANEL_REMOTE)
  ctx.effect(() => {
    void mounted
      .then((dispose) => {
        off = dispose
        if (closed) dispose()
      })
      .catch((error) => update({ error: (error as Error).message }))
    return () => {
      closed = true
      off?.()
    }
  })
  // Cordis namespaces are traced services: injecting `remote` alone grants no namespace access.
  ctx.inject(['remote.sapperPanel'], (scoped) => {
    const invoke = async (method: string, input: object) => {
      await mounted
      const result = await PANEL_REMOTE.methods[
        'sapperPanel/' + method
      ]!.invoke(scoped.remote!, input)
      if (!('ok' in result)) throw new Error('Sapper 收到非预期流式结果')
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    const api: WorkbenchPanelApi = {
      capabilities: (input) => invoke('capabilities', { input }) as Promise<import('../panel/capabilities.js').Capabilities>,
      node: (input, id) =>
        invoke('node', { input, id }) as ReturnType<WorkbenchPanelApi['node']>,
      overview: () =>
        invoke('overview', {}) as ReturnType<WorkbenchPanelApi['overview']>,
      preferences: (input) =>
        invoke('preferences', { input }) as ReturnType<
          WorkbenchPanelApi['preferences']
        >,
      launch: (input) =>
        invoke('launch', { input }) as ReturnType<WorkbenchPanelApi['launch']>,
      prepare: (input) => invoke('prepare', { input }) as ReturnType<WorkbenchPanelApi['prepare']>,
      importAttachment: (input) => invoke('importAttachment', { input }) as ReturnType<WorkbenchPanelApi['importAttachment']>,
      detail: (input) =>
        invoke('detail', { input }) as ReturnType<WorkbenchPanelApi['detail']>,
      taskAction: (input, action) => invoke('taskAction', { input, action }),
      file: (input, name) =>
        invoke('file', { input, name }) as ReturnType<
          WorkbenchPanelApi['file']
        >,
      seen: (id) => invoke('seen', { id }) as Promise<void>,
      retryBrief: (jobId) => invoke('retryBrief', { jobId }) as Promise<void>,
      targets: () =>
        invoke('targets', {}) as ReturnType<WorkbenchPanelApi['targets']>,
      state: (sessionId) =>
        invoke('state', { sessionId }) as ReturnType<
          WorkbenchPanelApi['state']
        >,
      action: (sessionId, input) => invoke('action', { sessionId, input }),
      report: (sessionId) =>
        invoke('report', { sessionId }) as ReturnType<
          NonNullable<WorkbenchPanelApi['report']>
        >,
    }
    update({ api })
    scoped.effect(() => () => {
      if (!closed) update({ error: 'Sapper 连接已断开，正在等待服务恢复' })
    })
  })
  return source
}
