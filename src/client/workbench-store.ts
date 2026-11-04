import type { BrowserContext } from '../dsh-adapter/client.js'
import type { WorkbenchPanelApi } from '../panel/rpc.js'
import type { Challenge, WorkbenchSnapshot } from '../workbench/contracts.js'

/** Lives at the client root, independent of any rendered panel. */
export function workbenchController(ctx: BrowserContext) {
  let snapshot: {
      data?: WorkbenchSnapshot
      error?: string
      selected?: string
    } = {},
    api: WorkbenchPanelApi | undefined,
    disposed = false,
    loading = false
  const listeners = new Set<() => void>(),
    retained = new Map<string, { release(): void }>()
  const publish = () => {
    for (const listener of listeners) listener()
  }
  const select = (challenge?: Challenge) => {
    snapshot = { ...snapshot, selected: challenge?.id ?? '' }
    publish()
    if (challenge) void api?.seen(challenge.id)
  }
  const refresh = async () => {
    if (!api || loading || disposed) return
    loading = true
    try {
      const data = await api.overview()
      if (disposed) return
      const old = snapshot.data?.challenges.find(
        (c) => c.id === snapshot.selected,
      )
      const replacement =
        old && !data.challenges.some((c) => c.id === old.id)
          ? data.challenges.find(
              (c) =>
                (old.job && c.job?.id === old.job.id) ||
                (c.workspaceId === old.workspaceId && c.goal === old.goal),
            )
          : undefined
      snapshot = {
        ...snapshot,
        data,
        ...(replacement ? { selected: replacement.id } : {}),
      }
      delete snapshot.error
      publish()
      const sessions = new Set(
        data.jobs
          .filter(
            (j) =>
              ['queued', 'running', 'cancelling'].includes(j.state) ||
              data.briefs.some(
                (b) =>
                  b.jobId === j.id && ['queued', 'running'].includes(b.state),
              ),
          )
          .map((j) => j.sessionId),
      )
      for (const id of sessions)
        if (!retained.has(id) && ctx.sessions) {
          const ref = ctx.sessions.retain(id, { source: 'sapperTask' })
          retained.set(id, ref)
          void ref.ready.catch(() => {
            ref.release()
            retained.delete(id)
          })
        }
      for (const [id, ref] of retained)
        if (!sessions.has(id)) {
          ref.release()
          retained.delete(id)
        }
    } catch (error) {
      snapshot = { ...snapshot, error: (error as Error).message }
      publish()
    } finally {
      loading = false
    }
  }
  const timer = setInterval(() => {
    void refresh()
  }, 1500)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  ctx.effect(() => () => {
    disposed = true
    clearInterval(timer)
    for (const ref of retained.values()) ref.release()
    retained.clear()
  })
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    select,
    refresh,
    connect(value: WorkbenchPanelApi) {
      api = value
      void refresh()
    },
    open: () => ctx.layout?.selectPanel('sapper'),
    async reveal(result: {
      task_id: string
      job_id: string
      session_id?: string
    }) {
      await refresh()
      const challenge = snapshot.data?.challenges.find(
        (c) =>
          c.job?.id === result.job_id ||
          ((result.task_id !== 'legacy' || result.session_id === c.sessionId) &&
            c.phases.some((p) => p.taskId === result.task_id)),
      )
      if (challenge) select(challenge)
      ctx.layout?.selectPanel('sapper')
    },
  }
}
export type WorkbenchController = ReturnType<typeof workbenchController>
