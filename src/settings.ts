import Schema from '@deepseek-ai/schemastery'

const positive = (fallback: number, max: number) =>
  Schema.number().min(1).max(max).step(1).default(fallback)

function group<T extends Record<string, Schema>>(fields: T) {
  const schema = Schema.object(fields)
  return schema.default(schema({}))
}

/** This schema is also the single source of defaults for the settings namespace. */
const PlainConfig = group({
  enabled: Schema.boolean().default(true).description('启用 Sapper'),
  store: group({
    mode: Schema.union(['workspace', 'global']).default('workspace'),
    dir: Schema.string().default('.sapper'),
  }),
  autoInit: Schema.boolean().default(true).description('预留：M1 实现自动建图'),
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
    auto: Schema.boolean().default(false),
    maxSteps: positive(8, 100),
    maxExplore: positive(6, 100),
    maxVerify: positive(2, 10),
    concurrency: positive(2, 8),
    timeoutMin: positive(15, 120),
    requireApproval: Schema.boolean().default(true),
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
    autoCapture: Schema.boolean().default(true),
    patterns: Schema.array(Schema.string()).default(['flag\\{[^}]{1,200}\\}', 'ctf\\{[^}]{1,200}\\}']),
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
}
