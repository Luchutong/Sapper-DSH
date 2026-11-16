import type { Config } from '../settings.js'
import type { GraphSnapshot } from '../store/types.js'
import type { RecallMatch } from '../recall/index.js'
import { frontier, recentFirst } from './frontier.js'
import type { AccessView } from './frontier.js'
import { UNTRUSTED_NOTICE } from './context.js'

export interface KnowledgeBrief { id: string; title: string; description: string; tags: string[] }
export interface ContextExtras extends AccessView { recall?: RecallMatch[]; kb?: KnowledgeBrief[] }
function line(value: unknown): string { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') }
const brief = (node: { id: string; title?: string | null; description: string; doc?: string | null }) => ({
  id: node.id, title: node.title ?? null, description: node.description, has_doc: !!node.doc,
})

/** Whole-node paragraphs only. All dynamic sections, including KB/recall, share this one budget. */
export function renderGraphContext(graph: GraphSnapshot, config: Config, extras: ContextExtras = {}): { text: string; shown: number; omitted: number } {
  const header = UNTRUSTED_NOTICE + '\nBefore repeating work: read existing doc, recall related nodes, then decide what new evidence is needed.'
  const footer = '\nMore: sapper_status(view=graph/frontier), sapper_recall, sapper_doc, sapper_kb.'
  const budget = config.context.maxChars
  if (header.length > budget) return { text: '', shown: 0, omitted: 0 }
  const blocks: string[] = []
  const goal = `\nProject: ${line({ goal: graph.project.goal, status: graph.project.status, ...(graph.project.flag_policy ? { flag_policy: graph.project.flag_policy } : {}), ...(graph.project.verification_mode ? { verification_mode: graph.project.verification_mode } : {}) })}`
  blocks.push(goal)
  if (config.context.scope !== 'goal-only') {
    const view = frontier(graph, extras)
    blocks.push(`\nCounts: ${line({ facts: graph.facts.filter(f => f.id !== 'goal').length, open_intents: graph.intents.filter(i => i.to === null && i.evidence_completed !== true).length,
      ready: view.ready.length, warnings: graph.warnings.length, integrity: graph.integrity.length })}`)
    const categories = ['ready', 'pending_confirmation', 'missing_dependencies', 'in_flight', 'blocked_by_integrity'] as const
    for (const category of categories) for (const intent of view[category]) blocks.push(`\nFrontier/${category}: ${line({
      ...brief(intent), from: intent.from, status: intent.status, worker: intent.worker ?? null,
      confirmation: intent.requires_confirmation && !intent.confirmed_at && extras.fullAccess ? 'standing-full-access' : intent.confirmed_at ? 'confirmed' : null,
    })}`)
    const facts = recentFirst(graph.facts.filter(f => f.id !== 'goal')).slice(0, config.context.historyFacts)
    for (const fact of facts) blocks.push(`\nRecent fact: ${line({ ...brief(fact), kind: fact.kind ?? null, verification_status: fact.verification_status ?? 'observed' })}`)
    if (config.context.scope === 'frontier-history') {
      const closed = [...graph.intents.filter(i => i.to !== null)].sort((a, b) => {
        const x = a.concluded_at ?? '', y = b.concluded_at ?? ''
        return x > y ? -1 : x < y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      }).slice(0, 4)
      for (const intent of closed) blocks.push(`\nClosed intent: ${line({ ...brief(intent), to: intent.to })}`)
      for (const hint of recentFirst(graph.hints).slice(0, 4)) blocks.push(`\nHint: ${line({ id: hint.id, content: hint.content })}`)
    }
    for (const match of extras.recall ?? []) blocks.push(`\nRecall: ${line(match)}`)
    for (const entry of extras.kb ?? []) blocks.push(`\nKB: ${line(entry)}`)
  }
  let text = header, shown = 0, omitted = 0
  const reserve = footer.length + '\n[Sapper omitted: 999999999 paragraphs; use the tools above.]'.length
  for (const block of blocks) {
    if (text.length + block.length + reserve <= budget) { text += block; shown++ }
    else omitted++
  }
  const omittedLine = omitted ? `\n[Sapper omitted: ${omitted} paragraphs; use the tools above.]` : ''
  if (text.length + omittedLine.length + footer.length <= budget) text += omittedLine + footer
  else if (text.length + omittedLine.length <= budget) text += omittedLine
  else if (omitted && text.length + 32 <= budget) text += `\n[Sapper omitted: ${omitted}]`
  return { text, shown, omitted }
}

/** Human graph command is also bounded and does not open long documents. */
export function renderGraphView(graph: GraphSnapshot, maxChars: number): string {
  const rows = [
    `Project: ${line(graph.project)}`,
    ...graph.facts.map(f => `Fact: ${line({ ...brief(f), kind: f.kind ?? null, source_intent: f.source_intent, verification_status: f.verification_status ?? 'observed' })}`),
    ...graph.intents.map(i => `Intent: ${line({ ...brief(i), from: i.from, to: i.to, status: i.status, worker: i.worker ?? null })}`),
    ...graph.hints.map(h => `Hint: ${line(h)}`),
  ]
  let text = UNTRUSTED_NOTICE, omitted = 0
  if (text.length > maxChars) return ''
  for (const row of rows) {
    if (text.length + row.length + 100 <= maxChars) text += '\n' + row
    else omitted++
  }
  if (omitted && text.length + 80 <= maxChars) text += `\n[Sapper omitted: ${omitted} nodes; use sapper_doc / sapper_recall.]`
  return text
}
