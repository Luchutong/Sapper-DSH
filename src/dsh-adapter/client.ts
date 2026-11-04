import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComponentType } from 'react'
import type { ConfigForm, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/** Narrow client service contracts observed in DSH 0.2.1-rc.2.
 * Keep this browser-only seam separate from Node/Cordis host augmentations.
 */
export type BrowserSettingsScope = Pick<ConfigForm<unknown>, 'getSnapshot' | 'subscribe' | 'set' | 'mutate'>

interface SlotOptions {
  name: 'plugins.item' | 'settings.section' | 'conversation.composer.dock' | 'conversation.input.left' | 'conversation.chat.node' | 'sidebar.panellist' | 'main'
  id?: string
  key?: string
  label?: string
  order?: number
}

export interface BrowserContext {
  layout?: { selectPanel(id: 'sapper' | null): void }
  uiWorkspace?: {
    pickDirectory(): Promise<string | null>
    listDirectory?(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
    openSession(id: string): void
  }
  sessions?: { retain(id: string, options: { source: 'sapperTask' }): { ready: Promise<unknown>; release(): void } }
  remote?: TypertClientRemote
  uiConversation?: { events: Pick<ConversationEventRegistry, 'register'> }
  inject(services: string[], setup: (ctx: BrowserContext) => void): unknown
  configForms: {
    get(entryId: string): BrowserSettingsScope
    whileServed: ConfigForms['whileServed']
  }
  effect(setup: () => () => void, label?: string): unknown
  slots: {
    inject(name: SlotOptions['name'], setup: () => () => void): () => void
    register<Owner extends object>(options: SlotOptions, component: ComponentType<Owner>): () => void
  }
}
