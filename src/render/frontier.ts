import type { GraphSnapshot, Intent } from '../store/types.js'

export interface AccessView { fullAccess?: boolean; actor?: string }
export interface Frontier {
  ready: Intent[]; pending_confirmation: Intent[]; missing_dependencies: Intent[]
  in_flight: Intent[]; blocked_by_integrity: Intent[]
}
export function frontier(graph: GraphSnapshot, access: AccessView = {}): Frontier {
  const result: Frontier = { ready: [], pending_confirmation: [], missing_dependencies: [], in_flight: [], blocked_by_integrity: [] }
  const ids = new Set(graph.facts.map(f => f.id))
  const open = graph.intents.filter(i => i.to === null).sort((a, b) => Number(a.status !== 'claimed') - Number(b.status !== 'claimed') ||
    (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const intent of open) {
    if (intent.from.some(id => id === 'goal' || !ids.has(id))) result.missing_dependencies.push(intent)
    else if (intent.requires_confirmation && !intent.confirmed_at && !access.fullAccess) result.pending_confirmation.push(intent)
    else if (graph.warnings.length || graph.integrity.length || graph.project.status === 'completed') result.blocked_by_integrity.push(intent)
    else if (access.actor && intent.worker && intent.worker !== access.actor) result.in_flight.push(intent)
    else result.ready.push(intent)
  }
  return result
}
export const recentFirst = <T extends { id: string; created_at: string }>(nodes: T[]): T[] => [...nodes].sort((a, b) =>
  a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
