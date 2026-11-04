import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, link, unlink, lstat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { safePath } from '../store/io.js'
import { StoreError } from '../store/validation.js'
import type { AttachmentInput, LaunchFile, PublicAttachment } from './contracts.js'

export function attachmentPath(file: AttachmentInput, index: number): string {
  let name = file.name.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim()
  const extension = path.extname(name).slice(0, 16)
  name = Array.from(name.slice(0, name.length - path.extname(name).length)).slice(0, 80).join('') + extension
  if (!name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = 'attachment' + extension
  return `attachments/${String(index + 1).padStart(2, '0')}-${name}`
}
export function publicAttachments(files: LaunchFile[] = []): PublicAttachment[] {
  return files.filter((f) => f.sha256).map(({ id, name, path, bytes, sha256 }) => ({ id, name, path, bytes, sha256: sha256! }))
}
async function digest(file: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(file, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new StoreError('附件路径不是普通文件')
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let bytes = 0
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      hash.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead
    }
    return { sha256: hash.digest('hex'), bytes }
  } finally { await handle.close() }
}
export async function validateAttachment(cwd: string, file: LaunchFile): Promise<void> {
  const destination = path.resolve(cwd, file.path)
  await safePath(destination, cwd)
  const actual = await digest(destination)
  if (!file.sha256 || actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
    throw new StoreError(`附件 ${file.name} 已变化，请保留现有文件并检查后重试`)
}
/** Copy only SDK-authorized immutable bytes, with bounded memory and atomic,
 * no-overwrite publication. Interrupted staging files are never task inputs. */
export async function materializeAttachment(ctx: Context, cwd: string, file: LaunchFile): Promise<string> {
  if (!file.source) throw new StoreError(`请重新选择并上传附件：${file.name}`)
  const provider = ctx.get('attachments')
  if (!provider) throw new StoreError('DSH 附件存储服务尚未就绪')
  const destination = path.resolve(cwd, file.path), dir = path.dirname(destination)
  await safePath(destination, cwd)
  await mkdir(dir, { recursive: true })
  await safePath(destination, cwd)
  const temporary = path.join(dir, '.sapper-upload-' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx', 0o600), hash = createHash('sha256')
  let bytes = 0
  try {
    try {
      for await (const chunk of provider.readFileStream(file.source)) {
        bytes += chunk.byteLength
        if (bytes > file.bytes) throw new StoreError('附件存储返回的大小与上传记录不一致')
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset, null)).bytesWritten
      }
      if (bytes !== file.bytes) throw new StoreError('附件存储返回的文件不完整')
      await handle.sync()
    } finally { await handle.close() }
    const sha256 = hash.digest('hex')
    await safePath(destination, cwd)
    try { await link(temporary, destination) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await lstat(destination)).isFile()) throw new StoreError(`附件目标已被其他内容占用：${file.name}`)
      const current = await digest(destination)
      if (current.sha256 !== sha256 || current.bytes !== bytes)
        throw new StoreError(`附件目标已有不同内容，未覆盖：${file.name}`)
    }
    return sha256
  } finally { await unlink(temporary).catch(() => {}) }
}
