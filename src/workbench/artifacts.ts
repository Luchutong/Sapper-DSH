import path from 'node:path'
import { lstat, mkdir, open, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { GraphStore } from '../store/graph.js'
import { safePath, exists } from '../store/io.js'
import { runId as validateRunId } from '../store/runs.js'

/** Immutable per-run WP bytes; later verification or another WP cannot rewrite history. */
export async function archiveWriteup(
  store: GraphStore,
  id: string,
  cwd: string,
  guard: () => void,
) {
  const graph = await store.read()
  if (graph.project.purpose !== 'writeup') return
  guard()
  const target = path.join(store.root, 'artifacts', validateRunId(id), 'WP.md')
  await safePath(target, cwd)
  if (await exists(target)) return
  const source = path.join(cwd, 'WP.md')
  await safePath(source, cwd)
  if (!(await exists(source))) return
  if (!(await lstat(source)).isFile()) return
  const handle = await open(source, 'r')
  let bytes: Buffer
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1)
    let bytesRead=0
    while(bytesRead<buffer.length){const chunk=await handle.read(buffer,bytesRead,buffer.length-bytesRead,bytesRead);if(!chunk.bytesRead)break;bytesRead+=chunk.bytesRead}
    if (bytesRead === buffer.length)
      throw new Error('WP 超过 4 MiB，未归档；当前文件仍保留')
    bytes = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  guard()
  await mkdir(path.dirname(target), { recursive: true })
  guard()
  try {
    await writeFile(target, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  await writeFile(
    path.join(path.dirname(target), 'snapshot.json'),
    JSON.stringify(
      {
        run_id: id,
        captured_at: new Date().toISOString(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        goal: graph.project.goal,
        project_status: graph.project.status,
        flags: graph.facts
          .filter((f) => f.kind === 'flag')
          .map((f) => ({
            id: f.id,
            verification_status: f.verification_status,
          })),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  )
}
