import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import type { Orchestrator } from '../orchestration/engine.js'
import type { AuthorizeWrite } from './shared.js'
import { executionStore, json, output } from './shared.js'
import { StoreError } from '../store/validation.js'
import type { RunRecord } from '../store/runs.js'
import { defaultFlagPolicy } from '../orchestration/flag-policy.js'

function summary(run: RunRecord) {
  return { ...run, outcomes: run.outcomes.map(({ candidate, verification, ...brief }) => ({ ...brief,
    ...(candidate ? { candidate: { title: candidate.title, kind: candidate.kind, explorer_session: candidate.explorer_session, evidence_count: candidate.evidence.length } } : {}),
    ...(verification ? { verification: { verified: verification.verified, issues: verification.issues, verifier_session: verification.verifier_session, goal_achieved: verification.goal_achieved ?? false } } : {}),
  })) }
}

export function createDispatchTool(getConfig: () => Config, alive: () => boolean, authorize: AuthorizeWrite, engine: Orchestrator, lifecycle: { start(exec: ToolExecution): void; finish(exec: ToolExecution): void }) {
  return defineTool({
    name: 'sapper_dispatch',
    description: 'Run bounded Sapper orchestration with configurable flag_mode=first/count/all and verification_mode=none/lightweight/selective/independent. Fast modes record actual tool observations without launching a verifier; only independent verification creates confirmed facts. explore stores candidates; explicit verify always runs independently and needs run_id/intent_id. status is read-only; recover releases an interrupted run only after its executor stopped. Full access is standing authorization; other DSH policies apply. Requires an initialized healthy graph.',
    parameters: { mode: { type: 'string', enum: ['reason', 'explore', 'verify', 'run', 'status', 'recover'], required: true },
      intent_id: { type: 'string' }, run_id: { type: 'string' }, flag_mode: { type: 'string', enum: ['first', 'count', 'all'] }, flag_count: { type: 'integer' }, verification_mode: { type: 'string', enum: ['none', 'lightweight', 'selective', 'independent'] } }, output,
    isConcurrencySafe: args => args.mode === 'status',
    async execute(args, exec) {
      lifecycle.start(exec)
      try {
        const { store, options, creator } = await executionStore(getConfig, exec, alive, authorize)
        if (args.mode === 'status') return json(args.run_id ? await store.readRun(args.run_id) : (await store.listRuns()).slice(-20).reverse().map(summary))
        if (args.mode === 'recover') {
          if (!args.run_id || engine.isActive(store.root)) throw new StoreError('recover 需要遗留 run_id，且本工作区当前不能有活跃编排')
          return json(summary(await store.recoverRun(args.run_id, creator, options)))
        }
        if (!exec.agent) throw new StoreError('编排需要当前 DSH Agent')
        if ((args.flag_mode || args.verification_mode) && engine.isActive(store.root)) throw new StoreError('运行中请先停止，再调整策略继续')
        if (args.flag_mode) await store.configureFlagPolicy({ mode: args.flag_mode, count: args.flag_count ?? defaultFlagPolicy(getConfig().flags).count }, options)
        if (args.verification_mode) await store.configureVerification(args.verification_mode, options)
        if ((args.mode === 'explore' || args.mode === 'verify') && !args.intent_id) throw new StoreError('explore/verify 需要 intent_id')
        if (args.mode === 'verify' && !args.run_id) throw new StoreError('verify 需要候选 run_id')
        return json({ ...summary(await engine.dispatch(args.mode, store, creator, exec.agent, options, args.intent_id, args.run_id)), task_id: path.basename(store.root).startsWith('t-') ? path.basename(store.root) : 'legacy' })
      } finally { lifecycle.finish(exec) }
    },
  })
}
