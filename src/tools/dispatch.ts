import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../settings.js'
import type { Orchestrator } from '../orchestration/engine.js'
import type { AuthorizeWrite } from './shared.js'
import { executionStore, json, output } from './shared.js'
import { StoreError } from '../store/validation.js'
import type { RunRecord } from '../store/runs.js'

function summary(run: RunRecord) {
  return { ...run, outcomes: run.outcomes.map(({ candidate, verification, ...brief }) => ({ ...brief,
    ...(candidate ? { candidate: { title: candidate.title, kind: candidate.kind, explorer_session: candidate.explorer_session, evidence_count: candidate.evidence.length } } : {}),
    ...(verification ? { verification: { verified: verification.verified, issues: verification.issues, verifier_session: verification.verifier_session, goal_achieved: verification.goal_achieved ?? false } } : {}),
  })) }
}

export function createDispatchTool(getConfig: () => Config, alive: () => boolean, authorize: AuthorizeWrite, engine: Orchestrator, lifecycle: { start(exec: ToolExecution): void; finish(exec: ToolExecution): void }) {
  return defineTool({
    name: 'sapper_dispatch',
    description: 'Run bounded Sapper reason/explore/verify orchestration using DSH fresh subagents. mode=run advances ready intents and independently verifies actual tool evidence before confirming facts. explore stores a candidate only; verify needs run_id and intent_id. status is read-only; with run_id it reads the full evidence record. recover releases an interrupted running record only after its original executor has stopped. Full access is standing authorization; respect other DSH policies. Requires an initialized healthy graph with source facts.',
    parameters: { mode: { type: 'string', enum: ['reason', 'explore', 'verify', 'run', 'status', 'recover'], required: true },
      intent_id: { type: 'string' }, run_id: { type: 'string' } }, output,
    isConcurrencySafe: args => args.mode === 'status',
    async execute(args, exec) {
      lifecycle.start(exec)
      try {
        const { store, options, creator } = executionStore(getConfig, exec, alive, authorize)
        if (args.mode === 'status') return json(args.run_id ? await store.readRun(args.run_id) : (await store.listRuns()).slice(-20).reverse().map(summary))
        if (args.mode === 'recover') {
          if (!args.run_id || engine.isActive(store.root)) throw new StoreError('recover 需要遗留 run_id，且本工作区当前不能有活跃编排')
          return json(summary(await store.recoverRun(args.run_id, creator, options)))
        }
        if (!exec.agent) throw new StoreError('编排需要当前 DSH Agent')
        if ((args.mode === 'explore' || args.mode === 'verify') && !args.intent_id) throw new StoreError('explore/verify 需要 intent_id')
        if (args.mode === 'verify' && !args.run_id) throw new StoreError('verify 需要候选 run_id')
        return json(summary(await engine.dispatch(args.mode, store, creator, exec.agent, options, args.intent_id, args.run_id)))
      } finally { lifecycle.finish(exec) }
    },
  })
}
