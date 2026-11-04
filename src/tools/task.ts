import path from 'node:path'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import type { Orchestrator } from '../orchestration/engine.js'
import { createTask, selectTask } from '../store/tasks.js'
import { resolveStorePath } from '../store/paths.js'
import { executionStore, json, output, type AuthorizeWrite } from './shared.js'
import { StoreError } from '../store/validation.js'

export function createTaskTool(getConfig: () => Config, alive: () => boolean, authorize: AuthorizeWrite, engine: Orchestrator, lifecycle: { start(exec: ToolExecution): void; finish(exec: ToolExecution): void }) {
  const busy = new Set<string>()
  return defineTool({ name: 'sapper_task', description: 'Start a user goal in any existing DSH workspace. Automatically creates an isolated task graph and task-context record, then runs independent evidence verification. No fixture or manual init needed. action=resume selects an existing task_id (legacy for the original graph) and continues ready work. Does not overwrite old graphs.',
    parameters: { action: { type: 'string', enum: ['start', 'resume'], required: true }, goal: { type: 'string' }, task_id: { type: 'string' } }, output,
    async execute(args, exec) {
      lifecycle.start(exec)
      let base: string | undefined
      let claimed = false
      try {
        const { store: selected, options, creator } = await executionStore(getConfig, exec, alive, authorize)
        const cwd = exec.agent?.session.header.cwd
        base = resolveStorePath(cwd, getConfig())
        if (!base || !cwd || !exec.agent) throw new StoreError('需要当前 DSH 工作区会话')
        if (busy.has(base) || engine.isActive(selected.root)) throw new StoreError('当前工作区已有任务运行')
        busy.add(base); claimed = true
        options.guard(); exec.signal.throwIfAborted()
        const store = args.action === 'start'
          ? await createTask(base, cwd, args.goal ?? '', creator, options)
          : await selectTask(base, cwd, args.task_id ?? 'legacy', options)
        if ((await store.read()).project.status === 'completed') return json({ state: 'completed', stop_reason: 'goal-already-completed', task_id: store.root === base ? 'legacy' : path.basename(store.root) })
        return json({ ...await engine.dispatch('run', store, creator, exec.agent, options), task_id: store.root === base ? 'legacy' : path.basename(store.root) })
      } finally { if (base && claimed) busy.delete(base); lifecycle.finish(exec) }
    },
  })
}
