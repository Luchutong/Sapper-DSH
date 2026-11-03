import type { GraphSnapshot } from '../store/types.js'
import { frontier } from './frontier.js'
import type { AccessView } from './frontier.js'

export function graphStatus(graph: GraphSnapshot, access: AccessView = {}, includeRows = false) {
  const view = frontier(graph, access)
  const groups = ['ready', 'pending_confirmation', 'missing_dependencies', 'in_flight', 'blocked_by_integrity'] as const
  return {
    state: graph.project.status, goal: graph.project.goal,
    counts: { facts: graph.facts.filter(f => f.id !== 'goal').length, intents: graph.intents.length,
      open_intents: graph.intents.filter(i => i.to === null).length, hints: graph.hints.length, flags: graph.facts.filter(f => f.kind === 'flag').length },
    frontier: Object.fromEntries(groups.map(key => [key, { total: view[key].length, ids: view[key].slice(0, 20).map(i => i.id) }])),
    ...(includeRows ? { frontier_rows: Object.fromEntries(groups.map(key => [key, view[key].slice(0, 20).map(({ doc: _doc, ...node }) => node)])) } : {}),
    warnings: graph.warnings, integrity: graph.integrity,
  }
}
