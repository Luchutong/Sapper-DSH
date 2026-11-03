import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { StoreError } from './validation.js'

export function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
export async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if (absent(error)) return false; throw error }
}
/** Reject symlinks/junctions at every existing component below the selected boundary. */
export async function safePath(file: string, boundary: string): Promise<void> {
  const relative = path.relative(boundary, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new StoreError('存储路径越过工作区边界')
  let current = boundary
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new StoreError(`拒绝存储中的符号链接或 junction: ${current}`)
    } catch (error) { if (absent(error)) return; throw error }
  }
}
export async function readJson(file: string): Promise<unknown> {
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file))
    return JSON.parse(content) as unknown
  }
  catch (error) { throw new StoreError(`无法读取 ${path.basename(file)}: ${(error as Error).message}`) }
}
/** Same-directory, exclusive temporary file; never unlink the previous target to replace it. */
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2) + '\n'
  await mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    for (let retry = 0; ; retry++) {
      try { await rename(temp, file); break }
      catch (error) {
        if (process.platform !== 'win32' || retry >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await delay(30 * (retry + 1))
      }
    }
  } finally { await unlink(temp).catch(error => { if (!absent(error)) throw error }) }
}

const queues = new Map<string, Promise<unknown>>()
export async function serial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
  const previous = queues.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(action)
  queues.set(key, pending)
  try { return await pending } finally { if (queues.get(key) === pending) queues.delete(key) }
}
