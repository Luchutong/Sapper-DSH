import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, validateConfig } from './settings.js'
import type { RuntimeConfig } from './settings.js'
import { registerRuntime } from './dsh-adapter/host.js'

export { Config }
export const name = 'sapper-dsh'
export const inject = ['tools', 'agents']

export function apply(ctx: Context, config: RuntimeConfig): void {
  const getConfig = () => config.get()
  validateConfig(getConfig())
  // DSH 0.2 derives forms from the Loader entry's Config.
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  registerRuntime(ctx, getConfig)
}
