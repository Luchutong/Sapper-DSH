import { defineTool } from '@deepseek-ai/dsh-tools'
import { json, output } from '../tools/shared.js'
import { BrokerError, capabilityId } from './contracts.js'
import type { ToolBroker } from './broker.js'
export function brokerTools(broker: ToolBroker) {
  return [
    defineTool({ name: 'sapper_observe', description: '查询当前可用测量、检查声明前提，或登记明确标为推断的解释及失败恢复计划。不能把模型填写的值变成实测事实；不会自动重放命令。',
      parameters: { action: { type: 'string', enum: ['list', 'require', 'infer', 'diagnose'], required: true }, receiptId: { type: 'string' }, claim: { type: 'string' }, value: { type: 'string', description: 'JSON encoded inference, not a measured value' }, preserve: { type: 'array', items: { type: 'string' } }, invalidate: { type: 'array', items: { type: 'string' } }, ids: { type: 'array', items: { type: 'string' } }, resumeFrom: { type: 'string', enum: ['current-state', 'last-safe-checkpoint', 'fresh-resource'] }, nextCapability: { type: 'string' }, reason: { type: 'string' } }, output,
      isConcurrencySafe: (args) => ['list', 'require'].includes(args.action),
      async execute(args, exec) { if (!exec.agent) throw new BrokerError('SCOPE_DENIED', '需要实际 Agent'); return json(broker.observe(String(exec.agent.id), args)) } }),
    defineTool({ name: 'sapper_interact', description: '通过已配置的原生 MCP 适配器管理本 Agent 的 GDB/远程交互会话。每次操作使用稳定 requestId；write 超时不得换 ID 盲目重发。read 的 base64 页按字节游标返回。',
      parameters: { action: { type: 'string', enum: ['start', 'read', 'write', 'interrupt', 'stop', 'snapshot'], required: true }, requestId: { type: 'string', required: true }, profileId: { type: 'string' }, sessionRef: { type: 'string' }, data: { type: 'string' }, encoding: { type: 'string', enum: ['utf-8', 'base64'] }, cursor: { type: 'integer' }, waitMs: { type: 'integer' }, maxBytes: { type: 'integer' } }, output,
      async execute(args, exec) { if (!exec.agent) throw new BrokerError('SCOPE_DENIED', '需要实际 Agent'); return json(await broker.interact(exec.agent, args, exec.signal)) } }),
    defineTool({ name: 'sapper_tools', description: '只读搜索当前作用域允许的 MCP 工具与资源能力，或展开精确参数；不创建连接、不激活权限、不执行 MCP 业务工具。',
      parameters: { action: { type: 'string', enum: ['search', 'describe', 'status'], required: true }, query: { type: 'string' }, name: { type: 'string' } }, output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!exec.agent) throw new BrokerError('SCOPE_DENIED', '需要实际 Agent')
        if (args.action === 'status') return json(broker.selection(String(exec.agent.id)) ?? { message: '主会话可见目录；执行仍需宿主和连接器授权' })
        const tools = broker.catalog(exec.agent, args.action === 'describe' ? args.name ?? '' : args.query ?? '')
        return json(args.action === 'describe' ? tools.find((t) => t.name === args.name) ?? { missing: true } : tools.map(({ schema: _schema, ...tool }) => tool))
      } }),
    defineTool({ name: 'sapper_resource', description: '查看当前工作流资源，或申请新的能力组。acquire 只登记需求；下一推理边界排空、释放并重新分配，不扩大父会话或连接器权限。',
      parameters: { action: { type: 'string', enum: ['status', 'acquire'], required: true }, capabilities: { type: 'array', items: { type: 'string' } } }, output,
      isConcurrencySafe: (args) => args.action === 'status',
      async execute(args, exec) {
        if (!exec.agent) throw new BrokerError('SCOPE_DENIED', '需要实际 Agent')
        if (args.action === 'status') return json(broker.info(String(exec.agent.id)) ?? { leases: [] })
        const requested = (args.capabilities ?? []).map((c) => capabilityId.parse(c))
        if (!requested.length || requested.length > 32) throw new BrokerError('CAPABILITY_MISSING', '需要 1–32 项明确能力')
        return json(broker.request(String(exec.agent.id), requested))
      } }),
  ]
}
