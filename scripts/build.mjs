import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Invoke the exported CLI with Node: no shell quoting, platform-specific shim,
// or globally installed package-manager executable is needed inside scripts.
const root = new URL('../', import.meta.url)
await rm(new URL('lib/', root), { recursive: true, force: true })
const require = createRequire(import.meta.url)
const result = spawnSync(process.execPath, [require.resolve('tsdown/run')], {
  cwd: fileURLToPath(root), stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
await import('./wrap-client.mjs')
