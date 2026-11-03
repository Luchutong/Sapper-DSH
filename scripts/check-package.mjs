import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
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

const require = createRequire(import.meta.url)
const allowed = new Set(['react', 'react/jsx-runtime'])
let registration
const code = await readFile(new URL('lib/client.js', root), 'utf8')
vm.runInNewContext(code, { window: { __ModuleLoader__: { load: entry => { registration = entry } } } })
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
}
client.apply({
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
assert.deepEqual(registrations.map(row => row.name), ['plugins.item', 'settings.section'])
const kb = (await readdir(new URL('resources/kb/', root))).filter(file => file.endsWith('.json'))
assert.equal(kb.length, 56)
console.log('Package checks passed: host import, lazy-CJS client, settings slots, no eager writes, 56 KB resources.')
