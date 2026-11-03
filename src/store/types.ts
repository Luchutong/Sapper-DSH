/** JSON contracts shared with sapper-v2's Python Store. Unknown fields survive edits. */
export type FactKind = 'host' | 'service' | 'cred' | 'vuln' | 'loot' | 'flag' | 'note'

export interface Fact {
  id: string
  title?: string | null
  description: string
  doc?: string | null
  kind?: FactKind | null
  data?: Record<string, string> | null
  created_at: string
  creator: string
  source_intent: string | null
}

export interface Intent {
  id: string
  from: string[]
  to: string | null
  title?: string | null
  description: string
  doc?: string | null
  status: 'open' | 'claimed' | 'done' | 'complete'
  worker?: string | null
  requires_confirmation: boolean
  confirmed_at: string | null
  concluded_at: string | null
  created_at: string
  creator: string
  [key: string]: unknown
}

export interface Project {
  id: string
  origin: string
  goal: string
  status: 'active' | 'completed'
  created_at: string
  counters: Record<'fact' | 'intent' | 'hint' | 'run', number>
  completed_at?: string
  [key: string]: unknown
}

export interface Hint {
  id: string
  content: string
  creator: string
  created_at: string
}

export interface GraphSnapshot {
  project: Project
  facts: Fact[]
  intents: Intent[]
  hints: Hint[]
  warnings: string[]
  integrity: string[]
}

export interface StoreReader {
  read(): Promise<GraphSnapshot>
}
