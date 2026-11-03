/** Persistence contracts for M1; no graph writer is shipped in this scaffold. */
export type FactKind = 'host' | 'service' | 'cred' | 'vuln' | 'loot' | 'flag' | 'note'

export interface Fact {
  id: string
  title?: string
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
  title?: string
  description: string
  doc?: string | null
  status: 'open' | 'claimed' | 'done' | 'complete'
  worker?: string | null
  requires_confirmation: boolean
  confirmed_at: string | null
  concluded_at: string | null
  created_at: string
  creator: string
}

export interface Project {
  id: string
  origin: string
  goal: string
  status: 'active' | 'completed'
  created_at: string
  counters: Record<'fact' | 'intent' | 'hint' | 'run', number>
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
}

export interface StoreReader {
  read(): Promise<GraphSnapshot>
}
