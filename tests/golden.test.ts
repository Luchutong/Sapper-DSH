import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { GraphStore } from '../src/store/graph.js'
import type { Fact, GraphSnapshot } from '../src/store/types.js'
import provenance from './reference/provenance.json'

const exec = promisify(execFile)
const referenceRoot = fileURLToPath(new URL('./reference/', import.meta.url))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper golden 中文 '))
  roots.push(cwd)
  const root = path.join(cwd, '.sapper')
  return { root, store: new GraphStore(root, cwd) }
}
async function python(action: string, root: string) {
  const { stdout } = await exec(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
    [path.join(referenceRoot, 'bridge.py'), action, root], { env: { ...process.env, PYTHONUTF8: '1' } })
  return JSON.parse(stdout) as GraphSnapshot
}

describe('unchanged upstream Python Store golden round trips', () => {
  it('pins the reference source and reads exactly the Python-created graph', async () => {
    const source = await readFile(path.join(referenceRoot, 'sapper_store.py'))
    expect(createHash('sha256').update(source).digest('hex')).toBe(provenance.snapshot_sha256)
    const { root, store } = await fixture()
    const expected = await python('seed', root)
    const graph = await store.read()
    expect(graph.project).toEqual(expected.project)
    expect(graph.facts).toEqual(expected.facts)
    expect(graph.intents).toEqual(expected.intents)
    expect(graph.hints).toEqual(expected.hints)
    expect(graph.warnings).toEqual([])
    expect(graph.integrity).toEqual([])
    expect(store.flagEntries(graph.facts)).toMatchObject([{ value: 'flag{GOLDEN}', status: 'recorded' }])
  })
  it('allows Python → TS → Python → TS edits, preserving extensions, docs, links and flag status', async () => {
    const { root, store } = await fixture()
    await python('seed', root)
    await store.updateDoc('f001', 'TS evidence on a Python fact', null)
    const service = await store.addFact({ description: 'TS observed service', title: 'TS service', kind: 'service', data: { port: 443 } }, 'ts')
    const intent = await store.addIntent({ from: ['f002'], description: 'verify fixture' }, 'ts')
    await store.intentAction('claim', intent.id, 'ts')
    await store.addFact({ description: 'TS produced evidence', source_intent: intent.id }, 'ts')
    await store.updateFlag('f003', 'submitted', 'TS explicit update')
    expect((await store.recordFlag(' flag{GOLDEN} ', 'ts')).duplicate).toBe(true)
    await store.addHint('TS hint', 'ts')
    let expected = await python('inspect', root)
    let graph = await store.read()
    expect(graph.project).toEqual(expected.project)
    expect(graph.facts).toEqual(expected.facts)
    expect(graph.intents).toEqual(expected.intents)
    expect((graph.project.upstream_extension as { preserve: boolean }).preserve).toBe(true)
    expect((graph.facts.find(f => f.id === 'f001') as Fact & { extension: unknown }).extension).toEqual({ nested: [1, 2, 3] })
    expected = await python('append', root)
    graph = await store.read()
    expect(graph.facts).toEqual(expected.facts)
    expect(graph.hints).toEqual(expected.hints)
    expect((await store.readNode('fact', service.id)).doc).toBe('Python edited TS document')
    expect(store.flagEntries(graph.facts)[0]?.status).toBe('rejected')
    // The stale TS ledger must not override lifecycle updates made by Python.
    expect((await store.recordFlag('flag{GOLDEN}', 'ts')).entry.status).toBe('rejected')
    const completion = await store.addIntent({ from: [service.id], description: 'goal verified' }, 'ts')
    await store.intentAction('conclude', completion.id, 'ts', 'goal')
    expect((await python('inspect', root)).project.status).toBe('completed')
    expect((await store.read()).integrity).toEqual([])
  })
})
