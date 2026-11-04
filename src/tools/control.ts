import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TaskPanelService } from '../dsh-adapter/panel.js'
import { json, output } from './shared.js'
import { StoreError } from '../store/validation.js'

/** Main-session intervention without making the chat wait for background execution. */
export function createControlTool(jobs: TaskPanelService) {
  return defineTool({ name: 'sapper_control', description: 'Control the user-authorized Sapper background task from the main conversation. status reads live progress; result sends saved results to this chat. steer accepts the user new direction, stops/drains old child work and automatically starts a linked phase. continue starts a linked phase after any terminal state, including a completed goal; purpose=writeup writes a local WP from saved evidence, purpose=solve re-examines/corrects a flag. cancel stops work. Do not invent user instructions or expand target scope.',
    parameters: { action: { type: 'string', enum: ['status', 'result', 'steer', 'continue', 'cancel'], required: true }, goal: { type: 'string', description: 'User-provided direction or follow-up goal.' }, purpose: { type: 'string', enum: ['solve', 'writeup'] } }, output,
    async execute(args, exec) {
      if (!exec.agent) throw new StoreError('需要当前主会话')
      if (args.action === 'status') return json(await jobs.state(String(exec.agent.id)))
      if (args.action === 'result') return json(await jobs.report(String(exec.agent.id)))
      return json(jobs.submit(exec.agent, { action: args.action, ...(args.goal ? { goal: args.goal } : {}), ...(args.purpose ? { purpose: args.purpose } : {}) }))
    },
  })
}
