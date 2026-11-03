import type { ComponentType } from 'react'
import type { ConfigForm, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Narrow client service contracts observed in DSH 0.2.1-rc.2.
 * Keep this browser-only seam separate from Node/Cordis host augmentations.
 */
export type BrowserSettingsScope = Pick<ConfigForm<unknown>, 'getSnapshot' | 'subscribe' | 'set' | 'mutate'>

interface SlotOptions {
  name: 'plugins.item' | 'settings.section'
  id: string
  label?: string
  order?: number
}

export interface BrowserContext {
  configForms: {
    get(entryId: string): BrowserSettingsScope
    whileServed: ConfigForms['whileServed']
  }
  effect(setup: () => () => void, label?: string): unknown
  slots: {
    inject(name: SlotOptions['name'], setup: () => () => void): () => void
    register(options: SlotOptions, component: ComponentType<{ view?: string }>): () => void
  }
}
