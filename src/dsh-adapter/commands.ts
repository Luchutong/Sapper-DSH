import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {
  CommandInvocation,
  CommandResult,
} from '@deepseek-ai/dsh-commands'
import type { Config } from '../settings.js'
import { GraphStore } from '../store/graph.js'
import { resolveSelectedStore } from '../store/tasks.js'
import { StoreError } from '../store/validation.js'
import { KnowledgeBase, kbBrief } from '../kb/index.js'
import { recallGraph } from '../recall/index.js'
import { graphStatus } from '../render/status.js'
import { renderGraphView } from '../render/snapshot.js'
import { hasFullAccess } from './permissions.js'
import { UNTRUSTED_NOTICE } from '../render/context.js'
import type { TaskPanelService } from './panel.js'
import { randomUUID } from 'node:crypto'

const USAGE =
  '/sapper [status | graph | frontier | recall <query> | flag | kb <query|kb001> | start <goal> | run | runs | job | result | steer <方向> | continue <目标> | retry [纠错要求] | wp [要求] | verify <task_id> <run_id> <intent_id> | cancel]'
export function registerSapperCommand(
  ctx: Context,
  getConfig: () => Config,
  alive: () => boolean,
  jobs: Pick<TaskPanelService, 'submit' | 'state' | 'report'>,
): () => void {
  let sync = () => {}
  const kb = new KnowledgeBase()
  const handler = async (
    invocation: CommandInvocation,
  ): Promise<CommandResult> => {
    try {
      invocation.signal.throwIfAborted()
      const config = getConfig()
      if (!alive() || !config.enabled) throw new StoreError('Sapper 已关闭')
      const input = invocation.rawInput.trim()
      const [command = 'status', ...tail] = input.split(/\s+/u).filter(Boolean)
      const query = input.slice(command.length).trim()
      const cwd = invocation.agent.session.header.cwd
      if (['steer', 'continue', 'retry', 'wp'].includes(command)) {
        if ((command === 'steer' || command === 'continue') && !query) return { kind: 'error', text: USAGE }
        const goal = command === 'wp' ? `根据前序任务证据编写本地 WP（解题报告），保存为 WP.md；不重新访问外部目标。${query}` : query
        const accepted = jobs.submit(invocation.agent, { action: command === 'steer' ? 'steer' : 'continue', ...(goal ? { goal } : {}), purpose: command === 'wp' ? 'writeup' : 'solve' })
        return { kind: 'success', text: `已受理（${accepted.job_id}）。${command === 'steer' ? '停止原路线后自动按新方向继续。' : '已保留前序任务，正在启动后续阶段。'}` }
      }
      if (command === 'verify') {
        if (tail.length !== 3) return { kind: 'error', text: USAGE }
        const accepted = jobs.submit(invocation.agent, {
          action: 'verify',
          task_id: tail[0]!,
          run_id: tail[1]!,
          intent_id: tail[2]!,
        })
        return {
          kind: 'success',
          text: `独立复核已受理（${accepted.job_id}），只复核选定候选。`,
        }
      }
      if (command === 'start' || command === 'run' || command === 'cancel') {
        if (command === 'start' ? !query : tail.length) return { kind: 'error', text: USAGE }
        const accepted = jobs.submit(invocation.agent, command === 'start' ? { action: 'start', goal: query } : { action: command })
        if (command === 'cancel') return { kind: 'success', text: accepted.accepted ? '已请求取消，正在停止子会话和保存状态。用 /sapper job 查看清理结果。' : '当前工作区没有正在运行的任务。' }
        return { kind: 'success', text: `Sapper 后台任务已受理（${accepted.job_id}）。输入框可继续使用。用 /sapper job 查看进度，/sapper cancel 取消；也可打开 Sapper 任务面板。` }
      }
      if (command === 'result') {
        if (tail.length) return { kind: 'error', text: USAGE }
        const result = await jobs.report(String(invocation.agent.id))
        return { kind: 'success', text: result.summary }
      }
      if (command === 'job') {
        if (tail.length) return { kind: 'error', text: USAGE }
        return { kind: 'success', text: UNTRUSTED_NOTICE + '\n' + JSON.stringify(await jobs.state(String(invocation.agent.id)), null, 2) }
      }
      if (command === 'runs') {
        if (tail.length) return { kind: 'error', text: USAGE }
        const result = await ctx.tools.execute({ name: 'sapper_dispatch', arguments: { mode: 'status' }, agent: invocation.agent, callId: randomUUID() as never, signal: invocation.signal })
        return result.isError ? { kind: 'error', text: result.error.message } : { kind: 'success', text: UNTRUSTED_NOTICE + '\n' + JSON.stringify(result.value, null, 2) }
      }
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
      const root = await resolveSelectedStore(cwd, config)
      if (!root || !cwd) throw new StoreError('请先选择带绝对路径的工作区')
      const store = new GraphStore(root, cwd)
      await store.checkReadable()
      if (!await store.initialized()) return { kind: 'success', text: 'Sapper: uninitialized；请在授权任务中调用 sapper_init。' }
      const graph = await store.read()
      invocation.signal.throwIfAborted()
      if (!alive() || !getConfig().enabled)
        throw new StoreError('Sapper 已关闭')
      if (command === 'graph') return { kind: 'success', text: renderGraphView(graph, config.context.maxChars) }
      const data = command === 'recall' ? { matches: recallGraph(graph, query, config.context.recallTopK), warnings: graph.warnings }
        : command === 'flag' ? { entries: store.flagEntries(graph.facts), warnings: graph.warnings }
          : graphStatus(graph, { fullAccess: hasFullAccess(ctx, invocation), actor: String(invocation.agent.id) }, command === 'frontier')
      return {
        kind: 'success',
        text: UNTRUSTED_NOTICE + '\n' + JSON.stringify(data, null, 2),
      }
    } catch (error) {
      return { kind: 'error', text: (error as Error).message }
    }
  }
  ctx.inject(['commands'], child => {
    let dispose: (() => void) | undefined
    sync = () => {
      if (getConfig().enabled && !dispose) dispose = child.commands.register({
        definitionId: CommandDefinitionId('sapper-dsh:sapper'), name: 'sapper',
        description: '查询 Sapper 图、召回、KB 与运行记录，或后台启动/继续、查看进度及取消编排',
        input: { hint: USAGE }, handler,
      })
      if (!getConfig().enabled && dispose) { dispose(); dispose = undefined }
    }
    sync()
    child.effect(() => () => { dispose?.(); sync = () => {} })
  })
  return () => sync()
}
