import Schema from '@deepseek-ai/schemastery'
import { EXPLORE_TOOLS, VERIFY_TOOLS, validToolSelector } from './orchestration/tool-policy.js'

const positive = (fallback: number, max: number) =>
  Schema.number().min(1).max(max).step(1).default(fallback)

function group<T extends Record<string, Schema>>(fields: T) {
  const schema = Schema.object(fields)
  return schema.default(schema({}))
}

/** Single source of defaults for the plugin Config form. */
const PlainConfig = group({
  enabled: Schema.boolean().default(true).description('启用 Sapper'),
  store: group({
    mode: Schema.union(['workspace', 'global']).default('workspace'),
    dir: Schema.string().default('.sapper'),
    approval: Schema.union(['session', 'always']).default('session').description('图写入跟随会话权限；always 在工作区写入模式逐次确认，完全权限自动通过'),
  }),
  autoInit: Schema.boolean().default(true).description('兼容保留：状态查询不写入；面板发起任务会按明确目标自动创建独立图'),
  goal: Schema.string().default('拿到 flag'),
  context: group({
    inject: Schema.boolean().default(true),
    scope: Schema.union(['frontier', 'frontier-history', 'goal-only']).default('frontier'),
    maxChars: Schema.number().min(512).max(32000).step(1).default(6000),
    historyFacts: Schema.number().min(0).max(100).step(1).default(8),
    recallAuto: Schema.boolean().default(true),
    recallTopK: positive(5, 20),
  }),
  orchestration: group({
    auto: Schema.boolean().default(false).description('预留自动触发；当前用 sapper_dispatch 或 /sapper run 显式启动，启动后自动推进'),
    maxSteps: positive(24, 200),
    maxExplore: positive(20, 200),
    maxVerify: positive(2, 10),
    concurrency: positive(2, 8),
    timeoutMin: positive(45, 240),
    runTimeoutMin: positive(90, 720),
    budgetMode: Schema.union(['adaptive', 'fixed']).default('adaptive').description('自动模式在有新工具证据时延长步数；固定模式严格使用初始步数'),
    maxChildSteps: positive(24, 256).description('每个子代理的初始步数预算，包含最终结构化提交'),
    maxChildStepsCeiling: positive(128, 512).description('自动模式单个子代理的硬上限；临近上限时预留结构化收尾'),
    maxOutputTokens: positive(16384, 65536),
    requireApproval: Schema.boolean().default(true).description('工作区写入模式启动编排需审批；完全权限自动授权，不控制普通图写入'),
    exploreTools: Schema.array(Schema.string()).default(EXPLORE_TOOLS),
    verifyTools: Schema.array(Schema.string()).default(VERIFY_TOOLS),
    reasoningEffort: Schema.string().default('inherit').description('子代理默认推理强度；inherit 沿用父会话或模型默认'),
    reasoningEfforts: group({ reason: Schema.string().default('inherit'), explore: Schema.string().default('inherit'), verify: Schema.string().default('inherit') }),
    models: group({
      reason: Schema.string().default('inherit'),
      explore: Schema.string().default('inherit'),
      verify: Schema.string().default('inherit'),
    }),
  }),
  kb: group({
    enabled: Schema.boolean().default(true),
    customDir: Schema.string().default(''),
    injectTopK: Schema.number().min(0).max(20).step(1).default(3),
  }),
  flags: group({
    completion: Schema.union(['first', 'count', 'all']).default('first').description('首个即停、指定数量或持续收集；任务可单独覆盖'),
    targetCount: positive(2, 10000),
    autoCapture: Schema.boolean().default(true),
    patterns: Schema.array(Schema.string()).default(['flag\\{[^}]{1,200}\\}', 'ctf\\{[^}]{1,200}\\}']),
  }),
  verification: group({
    mode: Schema.union(['none', 'lightweight', 'selective', 'independent']).default('lightweight').description('默认仅在探索代理中轻量检查；完整独立复核可选'),
    criticalKinds: Schema.array(Schema.union(['host', 'service', 'cred', 'vuln', 'loot', 'flag', 'note'])).default(['flag', 'vuln', 'cred']),
  }),
  ui: group({ graphPreview: Schema.boolean().default(false) }),
})

// DSH 0.2 settings expose volatile Config fields through the profile editor.
export const Config = PlainConfig.volatile()
export type RuntimeConfig = ReturnType<typeof Config>
export type Config = ReturnType<RuntimeConfig['get']>
export type ConfigInput = Parameters<typeof PlainConfig>[0]

export function resolveConfig(input: ConfigInput = {}): Config {
  const config = PlainConfig(input)
  validateConfig(config)
  return config
}

export function validateConfig(config: Config): void {
  if (!config.store.dir.trim() || config.store.dir.includes('\0')) {
    throw new Error('store.dir 必须是非空路径，且不能包含 NUL')
  }
  for (const pattern of config.flags.patterns) new RegExp(pattern)
  for (const selected of Object.values(config.orchestration.models)) {
    if (!selected.trim() || selected.startsWith(':') || selected.endsWith(':')) throw new Error('角色模型必须是 inherit、model 或 provider:model')
  }
  for (const tool of [...config.orchestration.exploreTools, ...config.orchestration.verifyTools]) {
    if (!validToolSelector(tool)) throw new Error('外部工具范围无效；仅 MCP 命名空间支持末尾 *，禁止图写入、PTC 传输和递归委派')
  }
  for (const effort of [config.orchestration.reasoningEffort, ...Object.values(config.orchestration.reasoningEfforts)])
    if (!effort.trim() || effort.length > 128 || /[\x00-\x1f]/.test(effort)) throw new Error('推理强度必须是 inherit 或模型提供的有效档位 ID')
}
