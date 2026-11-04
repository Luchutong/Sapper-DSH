import type { BrowserContext } from '../dsh-adapter/client.js'
import type { WorkbenchApi, LaunchInput, LaunchRecord, AttachmentInput } from '../workbench/contracts.js'

export interface DraftAttachment extends AttachmentInput {
  file?: File
  loaded?: number
  stage?: 'selected' | 'uploading' | 'saving' | 'ready' | 'failed'
  error?: string | undefined
}
export type TransferUpdate = { id: string; loaded: number; stage: NonNullable<DraftAttachment['stage']>; error?: string }

/** A task is admitted only after every attachment has been durably imported. */
export async function launchWithAttachments(
  api: WorkbenchApi, ctx: BrowserContext, input: LaunchInput, drafts: DraftAttachment[],
  signal: AbortSignal, update: (progress: TransferUpdate) => void,
  complete?: (record: LaunchRecord) => Promise<void>,
): Promise<LaunchRecord> {
  signal.throwIfAborted()
  let record = await api.prepare(input)
  signal.throwIfAborted()
  if (record.jobId) { await complete?.(record); return record }
  let reference: ReturnType<NonNullable<BrowserContext['sessions']>['retain']> | undefined
  try {
    if (!record.sessionId) throw new Error('题目主会话尚未准备好')
    reference = ctx.sessions?.retain(record.sessionId, { source: 'sapperTask' })
    await reference?.ready
    for (const expected of input.attachments ?? []) {
      signal.throwIfAborted()
      if (record.files?.find((f) => f.id === expected.id)?.sha256) {
        update({ id: expected.id, stage: 'ready', loaded: expected.bytes }); continue
      }
      try {
        const file = drafts.find((f) => f.id === expected.id)?.file
        if (!file) throw new Error(`请重新选择未完成上传的附件：${expected.name}`)
        if (file.name !== expected.name || file.size !== expected.bytes) throw new Error(`重新选择的附件名称或大小不符：${expected.name}`)
        if (!ctx.fileUpload) throw new Error('DSH 文件上传服务尚未就绪')
        update({ id: expected.id, stage: 'uploading', loaded: 0 })
        const uploaded = await ctx.fileUpload.upload(
          record.sessionId as Parameters<NonNullable<BrowserContext['fileUpload']>['upload']>[0],
          file, file.name, signal, (p) => update({ id: expected.id, loaded: Math.min(expected.bytes, Math.max(0, p.loaded)), stage: 'uploading' }),
        )
        signal.throwIfAborted()
        if (!uploaded.ok) throw new Error(uploaded.error.message)
        update({ id: expected.id, stage: 'saving', loaded: expected.bytes })
        record = await api.importAttachment({ requestId: input.requestId, attachmentId: expected.id, receiptId: String(uploaded.value.receiptId) })
        signal.throwIfAborted()
        update({ id: expected.id, stage: 'ready', loaded: expected.bytes })
      } catch (error) {
        update({ id: expected.id, stage: 'failed', loaded: 0, error: signal.aborted ? '已取消，可继续上传' : (error as Error).message })
        throw error
      }
    }
    signal.throwIfAborted()
    const started = await api.launch(input)
    await complete?.(started)
    return started
  } catch (error) {
    if (signal.aborted) throw new Error('附件上传已取消，已保存的文件会保留，可继续创建')
    throw error
  } finally { reference?.release() }
}
