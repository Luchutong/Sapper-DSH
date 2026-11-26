import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { inspectIdaMetadata } from '../src/mcp/ida-metadata.js'

it('binds same-name IDBs to separate GUI instances and discards a replaced registration', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'sapper IDA 中文 '))
  const root = await realpath(temporary)
  const registrations = path.join(root, 'instances')
  const servers: ReturnType<typeof createServer>[] = []
  const signal = new AbortController().signal
  async function fixture(subdir: string, digest: string) {
    const file = path.join(root, subdir, 'sample.i64')
    await mkdir(path.dirname(file))
    await writeFile(file, '')
    let replyPath = file
    let replace = false
    const calls: unknown[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push({ url: req.url, method: rpc.method, params: rpc.params })
      if (replace) await save('2026-11-26T13:00:00Z')
      const meta = { path: replyPath, module: 'sample', base: '0x1000', size: '0x100', sha256: digest }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { contents: [{ uri: 'ida://idb/metadata', text: JSON.stringify(meta) }] } }))
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing HTTP listener')
    const port = address.port
    const save = (started_at: string) => writeFile(path.join(registrations, `instance_${port}.json`), JSON.stringify({ host: '127.0.0.1', port, pid: process.pid, idb_path: file, started_at }))
    await save('2026-11-26T12:00:00Z')
    return { port, file, calls, replace: () => { replace = true }, redirect: (otherFile: string) => { replyPath = otherFile } }
  }
  try {
    await mkdir(registrations)
    const [a, b] = await Promise.all([fixture('A', 'a'.repeat(64)), fixture('B', 'b'.repeat(64))])
    const read = (name: string) => inspectIdaMetadata(root, path.join(name, 'sample.i64'), signal, registrations)
    const [one, two] = await Promise.all([read('A'), read('B')])
    expect(one).toMatchObject({ path: path.join('A', 'sample.i64'), port: a.port, sha256: 'a'.repeat(64), duration_ms: expect.any(Number) })
    expect(two).toMatchObject({ path: path.join('B', 'sample.i64'), port: b.port, sha256: 'b'.repeat(64) })
    expect(a.calls).toEqual([{ url: '/mcp', method: 'resources/read', params: { uri: 'ida://idb/metadata' } }])
    a.redirect(b.file)
    await expect(read('A')).rejects.toThrow('数据库路径与绑定不一致')
    a.redirect(a.file)
    a.replace()
    await expect(read('A')).rejects.toThrow('重新登记')
    await expect(read('B')).resolves.toMatchObject({ port: b.port })
    await expect(inspectIdaMetadata(root, '../outside.i64', signal, registrations)).rejects.toThrow('工作区边界')
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
    await rm(temporary, { recursive: true, force: true })
  }
})
