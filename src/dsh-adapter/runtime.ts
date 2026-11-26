import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

export function isRootAgent(agent: Agent): boolean {
  return agent.session.header.parentSession === undefined
}

export async function executeTool(tools: Context['tools'], input: {
  agent: Agent
  name: string
  arguments: unknown
  callId: ToolCallId
  signal: AbortSignal
}) {
  const { agent, name, arguments: args, callId, signal } = input
  const batch = await tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args ?? {}) }] })
  const result = batch.results[0]
  if (!result || result.callId !== callId) throw new Error(`DSH 未返回工具 ${name} 的执行结果`)
  return result.result
}
