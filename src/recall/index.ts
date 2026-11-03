import type { Fact, GraphSnapshot } from '../store/types.js'
import { StoreError } from '../store/validation.js'

export const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function grams(value: string): Set<string> {
  const chars = Array.from(value)
  return new Set(chars.slice(1).map((char, index) => chars[index]! + char))
}
export function dice(a: string, b: string): number {
  const left = grams(a), right = grams(b)
  if (!left.size || !right.size) return 0
  return 2 * [...left].filter(value => right.has(value)).length / (left.size + right.size)
}
/** Primary matches are normalized substrings; word boundaries and bigrams rank fuzzy hits. */
export function matchText(query: string, title: string, description: string): { score: number; reasons: string[] } {
  const q = normalize(query), t = normalize(title), d = normalize(description)
  if (!q) return { score: 0, reasons: [] }
  const reasons: string[] = []
  let score = 0
  if (t.includes(q)) { score += 120; reasons.push('title-substring') }
  if (d.includes(q)) { score += 90; reasons.push('description-substring') }
  const words = [...new Set(q.match(/[a-z0-9_][a-z0-9_.-]+/g) ?? [])]
  const hits = words.filter(word => new RegExp(`(^|[^a-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_])`).test(`${t} ${d}`)).length
  if (hits) { score += 40 * hits / words.length; reasons.push('word-boundary') }
  const titleDice = dice(q, t), descDice = dice(q, d)
  if (!score && Math.max(titleDice, descDice) < 0.22) return { score: 0, reasons: [] }
  if (titleDice > 0) { score += 30 * titleDice; reasons.push('title-bigram') }
  if (descDice > 0) { score += 15 * descDice; reasons.push('description-bigram') }
  return { score: Math.round(score * 1000) / 1000, reasons }
}
export function limitResults(value: number, maximum = 20): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new StoreError(`limit 必须是 1–${maximum} 的整数`)
  return value
}
export interface RecallMatch {
  id: string; node_type: 'fact' | 'intent'; kind: Fact['kind'] | null; title: string | null
  description: string; has_doc: boolean; score: number; reasons: string[]
}
export function recallGraph(graph: GraphSnapshot, query: string, limit = 5, scope: 'all' | 'fact' | 'intent' = 'all'): RecallMatch[] {
  limitResults(limit)
  const nodes = [
    ...(scope === 'intent' ? [] : graph.facts.filter(f => f.id !== 'goal').map(node => ({ node, type: 'fact' as const }))),
    ...(scope === 'fact' ? [] : graph.intents.map(node => ({ node, type: 'intent' as const }))),
  ]
  return nodes.map(({ node, type }) => ({
    id: node.id, node_type: type, kind: type === 'fact' ? (node as Fact).kind ?? null : null,
    title: node.title ?? null, description: node.description, has_doc: !!node.doc,
    ...matchText(query, node.title ?? '', node.description),
  })).filter(node => node.score > 0).sort((a, b) => b.score - a.score || compare(a.id, b.id) || compare(a.node_type, b.node_type)).slice(0, limit)
}
