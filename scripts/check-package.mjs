import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'

await import('./check-compatibility.mjs')

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const patch = await readFile(new URL(manifest.dsh.bundle.patch, root), 'utf8')
assert.match(patch, /name: sapper-dsh/)
assert.equal(manifest.exports['./client'], './lib/client.js')
assert.equal(manifest.dsh.client.platform, 'web')
for (const file of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  assert.ok((await readFile(new URL(file, root))).length, `missing artifact: ${file}`)
}
const host = await import(new URL('lib/index.js', root))
assert.equal(typeof host.apply, 'function')
assert.ok(host.inject.includes('tools'))
assert.equal(typeof host.GraphStore, 'function')
const knowledge = new host.KnowledgeBase()
const knowledgeSnapshot = await knowledge.read()
assert.equal(knowledgeSnapshot.entries.length, 56)
assert.equal(knowledge.search(knowledgeSnapshot, 'Web 信息收集')[0].id, 'kb001')

// Exercise the packaged writer with independent Node processes, not just shared queues.
const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper processes 中文 '))
try {
  const storeRoot = path.join(cwd, '.sapper')
  const store = new host.GraphStore(storeRoot, cwd)
  await store.init('package check', 'cross-process writes')
  const run = promisify(execFile)
  await Promise.all(['writer-a', 'writer-b'].map(worker => run(process.execPath, [
    fileURLToPath(new URL('store-process-worker.mjs', import.meta.url)),
    new URL('lib/index.js', root).href, cwd, storeRoot, worker,
  ], { timeout: 30000 })))
  const graph = await store.read()
  assert.equal(graph.project.counters.fact, 8)
  assert.equal(graph.facts.length, 9)
  assert.deepEqual(graph.integrity, [])
  assert.deepEqual(graph.warnings, [])
} finally { await rm(cwd, { recursive: true, force: true }) }

const require = createRequire(import.meta.url)
const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom'])
let registration
const code = await readFile(new URL('lib/client.js', root), 'utf8')
vm.runInNewContext(code, { setInterval, clearInterval, setTimeout, clearTimeout, window: { __ModuleLoader__: { load: entry => { registration = entry } } } })
assert.equal(registration.id, manifest.name)
assert.equal(typeof registration.factory, 'function')
const client = registration.factory(specifier => {
  assert.ok(allowed.has(specifier), `browser bundle contains unexpected import: ${specifier}`)
  return require(specifier)
})
assert.equal(typeof client.apply, 'function')
const registrations = []
let writes = 0
const scope = {
  getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true }, base: {}, user: {}, revision: 0 }),
  subscribe: () => () => {}, set: async () => { writes++; return true },
  mutate: async () => { writes++; return true },
}
client.apply({
  inject: (_services, setup) => setup({}),
  configForms: {
    get: id => { assert.equal(id, 'sapper'); return scope },
    whileServed: (ids, setup) => { assert.deepEqual([...ids], ['sapper']); return setup(new Set(ids)) },
  },
  effect: setup => setup(),
  slots: {
    inject: (_name, setup) => setup(),
    register: (options, component) => { registrations.push(options); assert.equal(typeof component, 'function'); return () => {} },
  },
})
assert.equal(writes, 0, 'opening the client must not write settings')
assert.deepEqual(registrations.map(row => row.name), ['sidebar.panellist','main','conversation.input.left','plugins.item', 'settings.section'])
const kb = (await readdir(new URL('resources/kb/', root))).filter(file => file.endsWith('.json'))
assert.equal(kb.length, 56)
console.log('Package checks passed: host import, two-process store writes, lazy-CJS client, settings slots, no eager writes, 56 KB resources.')
