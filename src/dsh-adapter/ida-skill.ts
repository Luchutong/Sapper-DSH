import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { inspectIdaMetadata } from '../mcp/ida-metadata.js'
import { json, output } from '../tools/shared.js'
import type { Config } from '../settings.js'
import { safePath } from '../store/io.js'
import { IDA_METADATA_TOOL } from '../constants.js'

const skill = {
  name: 'sapper-ida-metadata',
  description: '只读检查当前工作区中已通过本地 IDA GUI 打开的 IDB。适用于确认数据库身份及基础元数据。',
  source: 'runtime',
  invocation: { modelInvocable: true, userInvocable: false },
  content: `只在需要检查本地 IDA GUI 中已打开的数据库时使用本 Skill。调用 sapper_ida_metadata，传入用户目标对应、位于工作区中的相对 .i64 或 .idb 路径。结果包含数据库路径、摘要（如服务可读）、实例端口、PID 和读取耗时。若报告实例未打开、身份变化或超时，说明实际阻塞。用户管理 IDA 窗口的打开和关闭。`,
}

export function isIdaSkillRequest(args: unknown) {
  return (args as { name?: unknown } | null)?.name === skill.name
}

export function createIdaMetadataTool(ctx: Context, getConfig: () => Config) {
  const activated = new WeakSet<Agent>()
  const enabled = () => getConfig().enabled && getConfig().mcpMode === 'skill'
  ctx.inject(['skills'], (scoped) => {
    let unregister: (() => void) | undefined
    const sync = () => {
      if (enabled()) unregister ??= scoped.skills.register(skill)
      else { unregister?.(); unregister = undefined }
    }
    sync()
    scoped.on('loader/volatile-update', sync)
  })
  ctx.on('agent/pre-step', (payload, next) => {
    if (payload.step === 1) activated.delete(payload.agent)
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    if (enabled() && exec.agent && exec.name === 'skill' && isIdaSkillRequest(exec.arguments) && !result.isError &&
      result.content.some((block) => block.type === 'text' && block.text.includes(skill.content))) activated.add(exec.agent)
  })

  return defineTool({
    name: IDA_METADATA_TOOL,
    description: '加载 sapper-ida-metadata Skill 后，检查当前工作区已打开的本地 IDA 数据库元数据。',
    parameters: { idb_path: { type: 'string', required: true } },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (!enabled() || !agent || !activated.has(agent)) throw new Error('请先在本轮加载 sapper-ida-metadata Skill')
      const cwd = agent.session.header.cwd
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      if (!cwd || !policy?.workspaceRoot || !path.isAbsolute(cwd) || !path.isAbsolute(policy.workspaceRoot)) throw new Error('需要有明确边界的 DSH 工作区')
      await safePath(cwd, policy.workspaceRoot)
      return json(await inspectIdaMetadata(cwd, args.idb_path, exec.signal))
    },
  })
}
