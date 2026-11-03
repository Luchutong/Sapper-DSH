import type { ComponentType } from 'react'

/** Narrow client service contracts observed in DSH NEXT 0.1.5-rc.1.
 * Keep this browser-only seam separate from Node/Cordis host augmentations.
 */
export interface SettingsView {
  status: 'loading' | 'ready' | 'unavailable'
  value?: { enabled: boolean; [key: string]: unknown } | undefined
  revision?: number | undefined
  writable: boolean
}

export interface BrowserSettingsScope {
  getSnapshot(): SettingsView
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

interface SlotOptions {
  name: 'settings.plugin.item' | 'settings.plugins.tab'
  key?: string
  id?: string
  label?: string
  order?: number
}

export interface BrowserContext {
  settingsScope: { bind(spec: { namespace: string }): BrowserSettingsScope }
  slots: {
    inject(name: SlotOptions['name'], setup: () => unknown): unknown
    register(options: SlotOptions, component: ComponentType): unknown
  }
}
