import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, resolveConfig } from './settings.js'
import type { ConfigInput } from './settings.js'
import { registerRuntime } from './dsh-adapter/host.js'

export { Config }
export const name = 'sapper-dsh'
export const inject = ['tools', 'agents', 'settings']

export function apply(ctx: Context, input: ConfigInput): void {
  const base = resolveConfig(input)
  const scope = ctx.settings.register('sapper', Config, { base, validate: resolveConfig })
  registerRuntime(ctx, () => scope.get())
}
