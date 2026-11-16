import path from 'node:path'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import type { Orchestrator } from '../orchestration/engine.js'
import { GraphStore } from '../store/graph.js'
import { createTask, selectTask, taskRoot } from '../store/tasks.js'
import { resolveStorePath } from '../store/paths.js'
import { executionStore, json, output, type AuthorizeWrite } from './shared.js'
import { StoreError } from '../store/validation.js'
import { defaultFlagPolicy } from '../orchestration/flag-policy.js'

export function createTaskTool(
  getConfig: () => Config,
  alive: () => boolean,
  authorize: AuthorizeWrite,
  engine: Orchestrator,
  lifecycle: {
    start(exec: ToolExecution): void
    finish(exec: ToolExecution): void
  },
  seedContext?: (exec: ToolExecution) => { title: string; kind: 'note'; description: string; doc: string } | undefined,
) {
  const busy = new Set<string>()
  return defineTool({
    name: 'sapper_task',
    description:
      'Start a user goal in any existing DSH workspace with configurable flag collection and review policy. Creates an isolated graph automatically. verification_mode=none/lightweight avoids automatic verifier agents; selective reviews configured important kinds; independent is the original full review. Only independently verified results become confirmed. flag_mode=first/count/all controls discovery stopping; flags are reported immediately. resume continues task_id; continue starts a linked phase without overwriting history. purpose=writeup prepares local WP without flag early stop. verify always independently checks only the selected candidate.',
    parameters: {
      action: {
        type: 'string',
        enum: ['start', 'resume', 'continue', 'verify'],
        required: true,
      },
      goal: { type: 'string' },
      task_id: { type: 'string' },
      purpose: { type: 'string', enum: ['solve', 'writeup'] },
      run_id: { type: 'string' },
      intent_id: { type: 'string' },
      flag_mode: { type: 'string', enum: ['first', 'count', 'all'], description: 'Completion policy explicitly selected by the user. all keeps collecting distinct flags; count stops at flag_count. Every new flag is reported immediately.' },
      flag_count: { type: 'integer' },
      verification_mode: { type: 'string', enum: ['none', 'lightweight', 'selective', 'independent'] },
    },
    output,
    async execute(args, exec) {
      lifecycle.start(exec)
      let base: string | undefined
      let claimed = false
      try {
        const { store: selected, options, creator } = await executionStore(getConfig, exec, alive, authorize)
        const cwd = exec.agent?.session.header.cwd
        base = resolveStorePath(cwd, getConfig())
        if (!base || !cwd || !exec.agent)
          throw new StoreError('需要当前 DSH 工作区会话')
        if (busy.has(base) || engine.isActive(selected.root))
          throw new StoreError('当前工作区已有任务运行')
        busy.add(base)
        claimed = true
        options.guard()
        exec.signal.throwIfAborted()
        const parentId =
          args.task_id ??
          (selected.root === base ? 'legacy' : path.basename(selected.root))
        const previous = args.action === 'continue' ? await new GraphStore(taskRoot(base, parentId), cwd).read() : undefined
        const store = args.action === 'continue'
          ? await createTask(base, cwd, args.goal?.trim() || (typeof previous!.project.solve_goal === 'string' ? previous!.project.solve_goal : previous!.project.goal), creator, options, { task_id: parentId, purpose: args.purpose ?? 'solve' })
          : args.action === 'start'
          ? await createTask(base, cwd, args.goal ?? '', creator, options)
          : await selectTask(base, cwd, args.task_id ?? 'legacy', options)
        const context = args.action === 'start' ? seedContext?.(exec) : undefined
        if (context) await store.addFact(context, creator, options)
        const project = (await store.read()).project
        if (project.purpose !== 'writeup' && (args.flag_mode || ((args.action === 'start' || args.action === 'continue') && !project.flag_policy)))
          await store.configureFlagPolicy({ mode: args.flag_mode ?? getConfig().flags.completion, count: args.flag_count ?? defaultFlagPolicy(getConfig().flags).count }, options)
        if (args.verification_mode || ((args.action === 'start' || args.action === 'continue') && !project.verification_mode)) await store.configureVerification(args.verification_mode ?? getConfig().verification.mode, options)
        if ((await store.read()).project.status === 'completed') return json({ state: 'completed', stop_reason: 'goal-already-completed', task_id: store.root === base ? 'legacy' : path.basename(store.root) })
        if (args.action === 'verify' && (!args.run_id || !args.intent_id))
          throw new StoreError('独立复核需要 run_id 和 intent_id')
        return json({
          ...(await engine.dispatch(
            args.action === 'verify' ? 'verify' : 'run',
            store,
            creator,
            exec.agent,
            options,
            args.intent_id,
            args.run_id,
          )),
          task_id: store.root === base ? 'legacy' : path.basename(store.root),
        })
      } finally {
        if (base && claimed) busy.delete(base)
        lifecycle.finish(exec)
      }
    },
  })
}
