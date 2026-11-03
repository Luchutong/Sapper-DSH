import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Config } from '../settings.js'
import { GraphStore } from '../store/graph.js'
import { resolveStorePath } from '../store/paths.js'
import { StoreError } from '../store/validation.js'
import { KnowledgeBase, kbBrief } from '../kb/index.js'
import { recallGraph } from '../recall/index.js'
import { graphStatus } from '../render/status.js'
import { renderGraphView } from '../render/snapshot.js'
import { hasFullAccess } from './permissions.js'
import { UNTRUSTED_NOTICE } from '../render/context.js'

const USAGE = '/sapper [status | graph | frontier | recall <query> | flag | kb <query|kb001>]'
export function registerSapperCommand(ctx: Context, getConfig: () => Config, alive: () => boolean): () => void {
  let sync = () => {}
  const kb = new KnowledgeBase()
  const handler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    try {
      invocation.signal.throwIfAborted()
      const config = getConfig()
      if (!alive() || !config.enabled) throw new StoreError('Sapper 已关闭')
      const input = invocation.rawInput.trim()
      const [command = 'status', ...tail] = input.split(/\s+/u).filter(Boolean)
      const query = tail.join(' ')
      const cwd = invocation.agent.session.header.cwd
      if (command === 'kb') {
        if (!config.kb.enabled) return { kind: 'success', text: 'Sapper KB 已关闭' }
        const snapshot = await kb.read(cwd, config.kb.customDir)
        invocation.signal.throwIfAborted()
        if (!alive() || !getConfig().enabled || !getConfig().kb.enabled) throw new StoreError('Sapper 或 KB 已关闭')
        const data = /^kb\d{3,}$/.test(query) ? kb.get(snapshot, query) : query ? kb.search(snapshot, query) : snapshot.entries.slice(0, 20).map(kbBrief)
        return { kind: 'success', text: UNTRUSTED_NOTICE + '\n' + JSON.stringify({ data, warnings: snapshot.warnings }, null, 2) }
      }
      if (!['status', 'graph', 'frontier', 'recall', 'flag'].includes(command) || (tail.length && command !== 'recall')) return { kind: 'error', text: USAGE }
      if (command === 'recall' && !query) return { kind: 'error', text: USAGE }
      const root = resolveStorePath(cwd, config)
      if (!root || !cwd) throw new StoreError('请先选择带绝对路径的工作区')
      const store = new GraphStore(root, cwd)
      await store.checkReadable()
      if (!await store.initialized()) return { kind: 'success', text: 'Sapper: uninitialized；请在授权任务中调用 sapper_init。' }
      const graph = await store.read()
      invocation.signal.throwIfAborted()
      if (!alive() || !getConfig().enabled) throw new StoreError('Sapper 已关闭')
      if (command === 'graph') return { kind: 'success', text: renderGraphView(graph, config.context.maxChars) }
      const data = command === 'recall' ? { matches: recallGraph(graph, query, config.context.recallTopK), warnings: graph.warnings }
        : command === 'flag' ? { entries: store.flagEntries(graph.facts), warnings: graph.warnings }
          : graphStatus(graph, { fullAccess: hasFullAccess(ctx, invocation), actor: String(invocation.agent.id) }, command === 'frontier')
      return { kind: 'success', text: UNTRUSTED_NOTICE + '\n' + JSON.stringify(data, null, 2) }
    } catch (error) { return { kind: 'error', text: (error as Error).message } }
  }
  ctx.inject(['commands'], child => {
    let dispose: (() => void) | undefined
    sync = () => {
      if (getConfig().enabled && !dispose) dispose = child.commands.register({
        definitionId: CommandDefinitionId('sapper-dsh:sapper'), name: 'sapper',
        description: '查看 Sapper 状态、图、frontier、召回、flag 与离线 KB（不调用模型）',
        input: { hint: USAGE }, handler,
      })
      if (!getConfig().enabled && dispose) { dispose(); dispose = undefined }
    }
    sync()
    child.effect(() => () => { dispose?.(); sync = () => {} })
  })
  return () => sync()
}
