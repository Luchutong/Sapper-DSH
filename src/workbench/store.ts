import type { Context } from '@deepseek-ai/cordis'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { preferencesSchema, type WorkbenchData } from './contracts.js'

const initial = (): WorkbenchData => ({
  preferences: { rootDir: '', parallelism: 2 },
  launches: {},
  jobs: {},
  briefs: {},
  seen: {},
})
const dataSchema = z.object({
  preferences: preferencesSchema,
  launches: z.record(
    z.string(),
    z
      .object({
        requestId: z.string(),
        cwd: z.string(),
        title: z.string(),
        input: z.object({ goal: z.string() }).passthrough(),
        createdAt: z.string(),
      })
      .passthrough(),
  ),
  jobs: z.record(
    z.string(),
    z
      .object({
        id: z.string(),
        sessionId: z.string(),
        cwd: z.string(),
        input: z.object({ action: z.string() }).passthrough(),
        state: z.string(),
        createdAt: z.string(),
      })
      .passthrough(),
  ),
  briefs: z.record(
    z.string(),
    z
      .object({
        jobId: z.string(),
        sessionId: z.string(),
        messageId: z.string(),
        state: z.enum(['queued', 'running', 'completed', 'failed']),
      })
      .passthrough(),
  ),
  seen: z.record(z.string(), z.string()),
})
const spec = defineDomain({
  name: 'sapper_workbench',
  version: 1,
  global: { schema: dataSchema, initial: initial() },
  tables: {},
})
/** A separate profile domain: UI preferences never invalidate execution authority. */
export class WorkbenchStore {
  private data = initial()
  private domain?: Domain<typeof spec>
  private chain: Promise<unknown> = Promise.resolve()
  ready: Promise<void> = Promise.resolve()
  durable = false
  constructor(ctx: Context, onReady: () => void) {
    ctx.inject(['storageDomain'], (scoped) => {
      this.ready = scoped.storageDomain.open(spec).then(async (domain) => {
        this.domain = domain
        this.data = structuredClone(domain.global.get()) as WorkbenchData
        for (const job of Object.values(this.data.jobs))
          if (job.state === 'running' || job.state === 'cancelling') {
            job.state = 'interrupted'
            job.error = 'DSH 已重启；请显式继续以恢复执行'
          }
        for (const brief of Object.values(this.data.briefs))
          if (brief.state === 'running' || brief.state === 'queued') {
            brief.state = 'failed'
            brief.error = '简报被中断，可重试；不会自动重放'
          }
        await domain.global.set(this.data)
        this.durable = true
        scoped.effect(() => () => domain.close())
        onReady()
      })
      this.ready.catch((error) =>
        ctx.logger.warn(
          'Sapper 工作台存储不可用：%s',
          (error as Error).message,
        ),
      )
    })
  }
  snapshot(): WorkbenchData {
    return structuredClone(this.data)
  }
  change(fn: (data: WorkbenchData) => void): Promise<void> {
    const next = this.chain.then(async () => {
      await this.ready
      const data = structuredClone(this.data)
      fn(data)
      if (this.domain) await this.domain.global.set(data)
      this.data = data
    })
    this.chain = next.catch(() => {})
    return next
  }
  async flush() {
    await this.ready
    await this.chain
  }
}
