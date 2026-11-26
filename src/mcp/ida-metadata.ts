import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { absent, safePath } from '../store/io.js'

const instance = z.object({
  host: z.enum(['127.0.0.1', 'localhost']),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive().max(0x7fffffff),
  idb_path: z.string().min(1),
  started_at: z.string().refine((date) => Number.isFinite(Date.parse(date))),
  backend: z.literal('gui').optional(),
})
type Instance = z.infer<typeof instance>

function instanceDirectory(): string {
  const appData = process.env.APPDATA
  if (process.platform === 'win32') {
    if (!appData || !path.isAbsolute(appData)) throw new Error('无法定位本机 IDA 实例目录')
    return path.join(appData, 'Hex-Rays', 'IDA Pro', 'mcp', 'instances')
  }
  return path.join(homedir(), '.idapro', 'mcp', 'instances')
}

async function readRegistration(file: string): Promise<Instance | undefined> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 8192) return
    const registration = instance.safeParse(JSON.parse(await readFile(file, 'utf8')))
    if (!registration.success || path.basename(file) !== `instance_${registration.data.port}.json`) return
    return registration.data
  } catch (error) {
    if (absent(error) || error instanceof SyntaxError) return
    throw error
  }
}

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

const envelope = z.object({
  jsonrpc: z.literal('2.0'), id: z.string(),
  result: z.object({ isError: z.literal(false).optional(), contents: z.tuple([z.object({ uri: z.literal('ida://idb/metadata'), text: z.string() })]) }),
})
const metadata = z.object({
  path: z.string(), module: z.string().max(512),
  base: z.string().regex(/^0x[0-9a-f]+$/i),
  size: z.string().regex(/^0x[0-9a-f]+$/i),
  sha256: z.string().regex(/^(?:[0-9a-f]{64}|unavailable)$/i),
})

async function readMetadata(registration: Instance, signal: AbortSignal) {
  const id = randomUUID()
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri: 'ida://idb/metadata' } })
  const result = await new Promise<string>((resolve, reject) => {
    const call = request({ hostname: '127.0.0.1', port: registration.port, path: '/mcp', method: 'POST', signal, agent: false,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body) } }, async (response) => {
      try {
        if (response.statusCode !== 200) throw new Error('IDA 元数据请求失败，HTTP ' + response.statusCode)
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of response) {
          length += chunk.length
          if (length > 32768) throw new Error('IDA 元数据响应超过上限')
          chunks.push(chunk)
        }
        resolve(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        response.destroy()
        reject(error)
      }
    })
    call.on('error', reject)
    call.end(body)
  })
  const parsed = envelope.parse(JSON.parse(result))
  if (parsed.id !== id) throw new Error('IDA 元数据响应 ID 不匹配')
  return metadata.parse(JSON.parse(parsed.result.contents[0].text))
}

/** Resolve a workspace IDB to one live GUI registration and read exactly one resource. */
export async function inspectIdaMetadata(workspace: string, relative: string, caller: AbortSignal, directory = instanceDirectory()) {
  const start = performance.now()
  const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)])
  signal.throwIfAborted()
  if (!path.isAbsolute(workspace) || relative.length > 4096 || path.isAbsolute(relative) || /^[a-z]:|[\0]/i.test(relative) || !/\.i(?:64|db)$/i.test(relative))
    throw new Error('需要当前工作区内的相对 .i64 或 .idb 路径')
  const root = await realpath(workspace)
  const target = path.resolve(root, relative)
  await safePath(target, root)
  if (!(await lstat(target)).isFile()) throw new Error('指定路径不是 IDB 文件')
  const idb = await realpath(target)
  await safePath(idb, root)
  const names = await readdir(directory).catch((error: unknown) => { if (absent(error)) return []; throw error })
  const candidates: Array<{ file: string; registration: Instance }> = []
  for (const name of names.filter((entry) => /^instance_\d{1,5}\.json$/.test(entry)).slice(0, 256)) {
    signal.throwIfAborted()
    const file = path.join(directory, name)
    const registration = await readRegistration(file)
    if (!registration || !path.isAbsolute(registration.idb_path) || path.relative(idb, registration.idb_path) !== '') continue
    if (isLive(registration.pid)) candidates.push({ file, registration })
  }
  const match = candidates[0]
  if (!match) throw new Error('该 IDB 没有可用的本地 IDA GUI 实例')
  if (candidates.length !== 1) throw new Error('该 IDB 对应多个实例，请只保留一个实例后重试')
  const result = await readMetadata(match.registration, signal)
  if (!path.isAbsolute(result.path) || path.relative(idb, result.path) !== '') throw new Error('IDA 响应中的数据库路径与绑定不一致')
  const current = await readRegistration(match.file)
  if (JSON.stringify(current) !== JSON.stringify(match.registration) || !isLive(match.registration.pid))
    throw new Error('IDA 实例在读取期间退出或重新登记，请重试')
  signal.throwIfAborted()
  return { ...result, path: path.relative(root, idb), port: match.registration.port, pid: match.registration.pid, duration_ms: Math.round(performance.now() - start) }
}
