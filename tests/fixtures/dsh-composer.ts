import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import type { CommandClaim } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface Attempt { seq: number; signal: AbortSignal }
interface Effect { type: string; attempt: Attempt; claim: CommandClaim; args: string }
interface Composer { readonly state: { phase: string }; dispatch(event: object): Effect[] }
/** Execute the exact pure submit machine shipped in DSH's pinned browser artifact.
 * Its package-private class is not exported by the lazy-CJS entry. No UI state
 * transitions are copied or mocked here; changing the SDK artifact fails loudly.
 */
export async function dshComposer(): Promise<Composer> {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
  const pkg = JSON.parse(await readFile(manifest, 'utf8'))
  if (pkg.version !== '0.2.1-rc.2') throw new Error('Composer probe requires the pinned DSH SDK')
  const code = await readFile(path.join(path.dirname(manifest), 'lib/client.js'), 'utf8')
  const marker = '//#region lib/types/client/input/machine.js'
  const start = code.indexOf(marker), end = code.indexOf('//#endregion', start)
  if (start < 0 || end < start) throw new Error('Published DSH composer machine was not found')
  const Machine = vm.runInNewContext(code.slice(start + marker.length, end) + '\nSubmitMachine', { AbortController }) as new () => Composer
  return new Machine()
}
