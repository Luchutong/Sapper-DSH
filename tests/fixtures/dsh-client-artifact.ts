import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { SDK_VERSION } from '../../src/constants.js'

const require = createRequire(import.meta.url)
const stores = {
  notifySubscribers(listeners: Set<() => void>) {
    for (const listener of listeners) listener()
  },
}

/** Run the published lazy-CJS bundle. Only expose additional internal bindings
 * needed by the probe. Browser-only imports unused by the probe are empty. */
export async function dshClientSource(pkg: string, symbols: string[] = []) {
  const manifest = JSON.parse(await readFile(require.resolve(pkg + '/package.json'), 'utf8'))
  if (manifest.version !== SDK_VERSION) throw new Error('Client probe requires the pinned DSH SDK: ' + pkg)
  const source = await readFile(require.resolve(pkg + '/client'), 'utf8')
  if (!symbols.length) return source
  const at = source.lastIndexOf('return module.exports')
  if (at < 0) throw new Error('DSH lazy-CJS export boundary missing: ' + pkg)
  return source.slice(0, at) + 'Object.assign(exports, {' + symbols.join(', ') + '}); ' + source.slice(at)
}

export async function dshClientProbe<T>(pkg: string, symbols: string[] = []): Promise<T> {
  let exports: T | undefined
  vm.runInNewContext(await dshClientSource(pkg, symbols), {
    AbortController,
    window: { __ModuleLoader__: { load(entry: { factory(resolve: (id: string) => unknown): T }) {
      const resolve = (id: string) => {
        if (id === '@deepseek-ai/dsh-client-store') return stores
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: (_target, key) => String(key) })
        if (id === '@tanstack/react-virtual') return {}
        return require(id)
      }
      exports = entry.factory(Object.assign(resolve, { asset: (path: string) => path }))
    } } },
  })
  if (!exports) throw new Error('DSH client factory missing: ' + pkg)
  return exports
}
