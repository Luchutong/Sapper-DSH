import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import { FACT_KINDS, FLAG_STATUSES, StoreError } from '../store/validation.js'
import { createStatusTool } from './status.js'
import { executionStore, json, output } from './shared.js'
import type { AuthorizeWrite } from './shared.js'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const fields = {
  description: { type: 'string', description: 'Observed evidence or a concrete task; cannot be empty for create.' },
  title: { type: 'string' }, doc: { type: 'string', description: 'Long-form evidence; title/description stay concise.' },
} as const
const nodeId = { type: 'string', description: 'Existing node ID, e.g. f001 / i001; paths are rejected.' } as const
const requiredId = { ...nodeId, required: true } as const
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new StoreError(`该操作需要参数 ${field}`)
  return value
}

export function createGraphTools(getConfig: () => Config, alive: () => boolean = () => true, authorize?: AuthorizeWrite, fullAccess?: (exec: ToolExecution) => boolean) {
  const storeFor = (exec: Parameters<typeof executionStore>[1]) => executionStore(getConfig, exec, alive, authorize)
  return [
    createStatusTool(getConfig, alive, fullAccess),
    defineTool({
      name: 'sapper_init',
      description: 'Initialize a Python-compatible workspace graph without overwriting files. Continue authorized Sapper work without extra chat confirmations; ordinary writes follow DSH session permissions. action=recover replays a pending transaction.',
      parameters: {
        action: { type: 'string', enum: ['create', 'recover'], description: 'Default: create.' },
        origin: { type: 'string', description: 'Project source/context, not a command.' },
        goal: { type: 'string', description: 'Nonempty project goal; defaults to Sapper settings.goal.' },
      }, output,
      async execute(args, exec) {
        const { store, options } = storeFor(exec)
        return json(args.action === 'recover' ? await store.recover(options) : await store.init(args.origin ?? '', args.goal ?? getConfig().goal, options))
      },
    }),
    defineTool({
      name: 'sapper_fact',
      description: 'Create/list/get immutable manually observed facts. create with source_intent atomically closes an ordinary open intent. M3 managed intents must instead pass sapper_dispatch independent verification; this tool cannot bypass that gate.',
      parameters: {
        action: { type: 'string', enum: ['create', 'get', 'list'], required: true },
        id: nodeId, ...fields,
        kind: { type: 'string', enum: FACT_KINDS },
        data: { type: 'object', additionalProperties: true, description: 'Flat key/value scalars; stored as strings.' },
        source_intent: { type: 'string', description: 'Optional intent to conclude; current session must own any claim. Required confirmation must exist, or is recorded automatically under the standing DSH full-access grant.' },
      }, output, isConcurrencySafe: args => args.action !== 'create',
      async execute(args, exec) {
        const { store, creator, options } = storeFor(exec)
        if (args.action === 'get') return json(await store.readNode('fact', required(args.id, 'id')))
        if (args.action === 'list') {
          const graph = await store.read()
          return json({ facts: graph.facts.map(({ doc: _doc, ...brief }) => brief), warnings: graph.warnings, integrity: graph.integrity })
        }
        return json(await store.addFact({ description: required(args.description, 'description'), title: args.title,
          doc: args.doc, kind: args.kind, data: args.data, source_intent: args.source_intent }, creator, options))
      },
    }),
    defineTool({
      name: 'sapper_intent',
      description: 'Create/list/get, claim/release, confirm or conclude an intent. Follow DSH session permissions: full access automatically satisfies Sapper confirmation gates without asking; workspace-write retains explicit confirm approval. Worker identity comes from this session.',
      parameters: {
        action: { type: 'string', enum: ['create', 'get', 'list', 'claim', 'release', 'confirm', 'conclude'], required: true },
        id: nodeId, ...fields,
        from: { type: 'array', items: { type: 'string' }, description: 'Nonempty dependency facts; goal cannot be a dependency.' },
        to: { type: 'string', description: 'Existing fact ID, or goal to complete the project.' },
        requires_confirmation: { type: 'boolean', description: 'Default false for autonomous work. True adds a decision gate: workspace-write needs approved confirm; full access is a standing grant and records confirmation automatically on confirm/claim/conclusion. Do not ask again for this gate in full access.' },
      }, output, isConcurrencySafe: args => args.action === 'get' || args.action === 'list',
      async execute(args, exec) {
        const { store, creator, options } = storeFor(exec)
        if (args.action === 'get') return json(await store.readNode('intent', required(args.id, 'id')))
        if (args.action === 'list') {
          const graph = await store.read()
          return json({ intents: graph.intents.map(({ doc: _doc, ...brief }) => brief), warnings: graph.warnings, integrity: graph.integrity })
        }
        if (args.action === 'create') return json(await store.addIntent({ from: required(args.from, 'from'),
          description: required(args.description, 'description'), title: args.title, doc: args.doc,
          requires_confirmation: args.requires_confirmation }, creator, options))
        return json(await store.intentAction(args.action, required(args.id, 'id'), creator, args.to, options))
      },
    }),
    defineTool({
      name: 'sapper_doc',
      description: 'Get or replace the long evidence document of a fact/intent. set requires expected_doc from the latest read (null for absent), preventing lost updates. No arbitrary file paths.',
      parameters: {
        action: { type: 'string', enum: ['get', 'set'], required: true }, id: requiredId,
        doc: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        expected_doc: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      }, output, isConcurrencySafe: args => args.action === 'get',
      async execute(args, exec) {
        const { store, options } = storeFor(exec)
        if (args.action === 'set') return json(await store.updateDoc(args.id, required(args.doc, 'doc'), required(args.expected_doc, 'expected_doc'), options))
        const graph = await store.read()
        const node = graph.facts.find(f => f.id === args.id) ?? graph.intents.find(i => i.id === args.id)
        if (!node) throw new StoreError(`节点 ${args.id} 不存在或已损坏；请检查 sapper_status`)
        return json({ id: node.id, title: node.title ?? null, description: node.description, doc: node.doc ?? null })
      },
    }),
    defineTool({
      name: 'sapper_flag',
      description: 'Record/deduplicate flags locally, list captures or update recorded/submitted/rejected/duplicate status from observed outcomes. Local metadata follows DSH session permissions; this never submits or validates a flag over the network.',
      parameters: {
        action: { type: 'string', enum: ['record', 'list', 'update'], required: true },
        id: nodeId, value: { type: 'string' }, status: { type: 'string', enum: FLAG_STATUSES },
        source_fact: { type: 'string' }, challenge: { type: 'string' }, note: { type: 'string' },
      }, output, isConcurrencySafe: args => args.action === 'list',
      async execute(args, exec) {
        const { store, creator, options } = storeFor(exec)
        if (args.action === 'list') {
          const graph = await store.read()
          return json({ entries: store.flagEntries(graph.facts), warnings: graph.warnings, integrity: graph.integrity })
        }
        if (args.action === 'update') return json(await store.updateFlag(required(args.id, 'id'), required(args.status, 'status'), args.note, options))
        return json(await store.recordFlag(required(args.value, 'value'), creator,
          { source_fact: args.source_fact, challenge: args.challenge, note: args.note }, options))
      },
    }),
  ]
}

export function isMutation(name: string, args: unknown): boolean {
  if (name === 'sapper_dispatch') return !(args && typeof args === 'object' && 'mode' in args && args.mode === 'status')
  if (name === 'sapper_init') return true
  const action = args && typeof args === 'object' && 'action' in args ? args.action : undefined
  if (name === 'sapper_fact' || name === 'sapper_intent') return action !== 'get' && action !== 'list'
  if (name === 'sapper_doc') return action !== 'get'
  if (name === 'sapper_flag') return action !== 'list'
  return false
}
export function requiresExplicitApproval(name: string, args: unknown): boolean {
  if (!args || typeof args !== 'object') return false
  const value = args as Record<string, unknown>
  return name === 'sapper_intent' && value.action === 'confirm'
}
