import { useEffect, useState, useSyncExternalStore } from 'react'
import type {
  BrowserContext,
  BrowserSettingsScope,
} from '../dsh-adapter/client.js'
import { GraphPreview } from './graph.js'
import { Workbench } from './workbench.js'
import { workbenchController } from './workbench-store.js'
import { connectPanel } from './connection.js'
import { resultDefinition, ResultNode } from './result.js'
import { VERSION } from '../constants.js'
import { CapabilitySettings, type SettingValue } from './capability-settings.js'
import type { WorkbenchPanelApi } from '../panel/rpc.js'
import { ResourceSettings, type BrokerApi } from './resource-settings.js'
import { verificationLabels } from './task-policy.js'

export const name = 'sapper-dsh'
export const inject = [
  'slots',
  'configForms',
  'remote',
  'uiConversation',
  'layout',
  'uiWorkspace',
  'sessions',
  'fileUpload',
]

function BudgetNumber({ label, value, min, max, disabled, save }: { label: string; value: number; min: number; max: number; disabled: boolean; save: (value: number) => Promise<boolean> }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return <input aria-label={label} type="number" min={min} max={max} value={draft} disabled={disabled} style={{ width: 110 }} onChange={e => setDraft(e.target.value)} onBlur={() => {
    const next = Number(draft)
    if (!Number.isInteger(next) || next < min || next > max) { setDraft(String(value)); return }
    if (next !== value) void save(next).then(accepted => { if (!accepted) setDraft(String(value)) })
  }} />
}

export function SapperSettings({ scope, api }: { scope: BrowserSettingsScope; api?: Pick<WorkbenchPanelApi, 'capabilities'> & BrokerApi | undefined }) {
  const state = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const enabled = typeof state.value === 'object' && state.value !== null &&
    'enabled' in state.value && state.value.enabled === true
  const storeValue = typeof state.value === 'object' && state.value !== null && 'store' in state.value ? state.value.store : null
  const approval = typeof storeValue === 'object' && storeValue !== null && 'approval' in storeValue && storeValue.approval === 'always' ? 'always' : 'session'

  const save = async (path: string[], value: SettingValue) => {
    setPending(true)
    setError('')
    try {
      const accepted = path.length === 1 ? await scope.set(path[0]!, value)
        : await scope.mutate([{ op: 'set', path, value }])
      if (!accepted) {
        setError('DSH 未接受此次保存。请重新加载设置，确认是否有其他窗口修改了配置。')
      }
      return accepted
    } catch {
      setError('保存失败。请重新加载设置，确认是否有其他窗口修改了配置。')
      return false
    } finally {
      setPending(false)
    }
  }

  const orchestration = (state.value as { orchestration?: Record<string, unknown> } | undefined)?.orchestration ?? {}
  const flags = (state.value as { flags?: { completion?: string; targetCount?: number } } | undefined)?.flags ?? {}
  const verification = (state.value as { verification?: { mode?: string; criticalKinds?: string[] } } | undefined)?.verification ?? {}
  const mcpMode = (state.value as { mcpMode?: string } | undefined)?.mcpMode ?? 'legacy'
  return (
    <section
      aria-label="Sapper 设置"
      style={{
        padding: 16,
        maxWidth: 720,
        overflowWrap: 'anywhere',
        color: 'inherit',
      }}
    >
      <h3>
        Sapper <small>{VERSION}</small>
      </h3>
      <p>工作区事实图与任务规划</p>
      <label>
        <input
          type="checkbox"
          aria-label="启用 Sapper"
          checked={enabled}
          disabled={state.status !== 'ready' || !state.writable || pending}
          onChange={(event) => {
            void save(['enabled'], event.target.checked)
          }}
        />{' '}
        启用 Sapper
      </label>
      <label style={{ display: 'block', marginTop: 12 }}>
        图写入确认{' '}
        <select
          aria-label="图写入确认"
          value={approval}
          disabled={state.status !== 'ready' || !state.writable || pending}
          onChange={(event) => {
            void save(['store', 'approval'], event.target.value)
          }}
        >
          <option value="session">跟随会话权限（自动）</option>
          <option value="always">受限模式下每次确认</option>
        </select>
      </label>
      <p>
        完全权限会自动通过 Sapper
        的确认门；工作区写入模式保留显式确认点。只读会话不写入，数据始终限于当前工作区。
      </p>
      <p role="status">
        {state.status === 'ready'
          ? enabled
            ? '已启用：提供事实图存储工具与目标摘要。'
            : '已关闭：工具和上下文注入均不生效。'
          : '正在等待 DSH 的 sapper 配置表单；不会自动写入默认值。'}
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset style={{ border: '1px solid #71809655', borderRadius: 8, marginTop: 20 }}><legend>默认完成与复核策略</legend>
        <label>默认 flag 策略{' '}<select aria-label="默认 flag 策略" value={flags.completion ?? 'first'} disabled={!state.writable || pending} onChange={(e) => { void save(['flags', 'completion'], e.target.value) }}>
          <option value="first">首个 flag 即停</option><option value="count">收集指定数量</option><option value="all">持续收集多个 flag</option>
        </select></label>
        <label style={{ display: 'block', margin: '10px 0' }}>默认目标 flag 数量{' '}<BudgetNumber label="默认目标 flag 数量" value={flags.targetCount ?? 2} min={1} max={10000} disabled={!state.writable || pending} save={(v) => save(['flags', 'targetCount'], v)} /></label>
        <label>默认自动复核{' '}<select aria-label="默认自动复核" value={verification.mode ?? 'lightweight'} disabled={!state.writable || pending} style={{ maxWidth: '100%' }} onChange={(e) => { void save(['verification', 'mode'], e.target.value) }}>
          {Object.entries(verificationLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select></label>
        {verification.mode === 'selective' && <div>自动独立复核的类型：{['flag', 'vuln', 'cred', 'loot', 'note', 'host', 'service'].map((kind) => <label key={kind} style={{ marginRight: 8 }}><input type="checkbox" aria-label={`独立复核 ${kind}`} checked={(verification.criticalKinds ?? ['flag', 'vuln', 'cred']).includes(kind)} disabled={!state.writable || pending} onChange={() => { const old = verification.criticalKinds ?? ['flag', 'vuln', 'cred']; void save(['verification', 'criticalKinds'], old.includes(kind) ? old.filter((k) => k !== kind) : [...old, kind]) }} />{kind}</label>)}</div>}
        <p>默认轻量模式不启动第二个代理；关闭自动复核仍保留成功工具证据检查。每题可覆盖这些默认值。调整默认值会停止当前编排，原阶段策略与历史记录保留。</p>
      </fieldset>
      <p>工具范围、模型和推理强度保存后会停止正在运行的编排，请在发起任务前设置。</p>
      <label>MCP 模式{' '}<select aria-label="MCP 模式" value={mcpMode} disabled={!state.writable || pending} onChange={(e) => { void save(['mcpMode'], e.target.value) }}>
        <option value="legacy">兼容模式（资源协调）</option>
        <option value="skill">按需 Skill（本地 IDA 元数据）</option>
      </select></label>
      {mcpMode === 'legacy' ? <ResourceSettings api={api} /> : <p>普通对话使用 DSH 的 MCP 连接。Sapper 子代理可按需读取已打开的本地 IDA 数据库元数据。</p>}
      <CapabilitySettings api={api} orchestration={orchestration} disabled={state.status !== 'ready' || !state.writable || pending} save={save} skillMode={mcpMode === 'skill'} />
      <fieldset
        style={{
          marginTop: 20,
          border: '1px solid #71809655',
          borderRadius: 8,
        }}
      >
        <legend>复杂任务预算</legend>
        <p>
          自动模式会在取得新工具证据时延长执行，并预留提交结论的步骤。调整设置会停止当前运行，请在启动前配置。
        </p>
        <label>
          预算策略{' '}
          <select
            aria-label="预算策略"
            value={String(orchestration.budgetMode ?? 'adaptive')}
            disabled={!state.writable || pending}
            onChange={(e) => {
              void save(['orchestration', 'budgetMode'], e.target.value)
            }}
          >
            <option value="adaptive">自动延长（推荐）</option>
            <option value="fixed">固定步数</option>
          </select>
        </label>
        {(
          [
            ['maxChildSteps', '初始步数', 24, 1, 256],
            ['maxChildStepsCeiling', '自动延长上限', 128, 1, 512],
            ['maxOutputTokens', '每轮输出 token 上限', 16384, 1, 65536],
            ['timeoutMin', '子代理时限（分钟）', 45, 1, 240],
            ['runTimeoutMin', '整轮时限（分钟）', 90, 1, 720],
          ] as const
        ).map(([key, label, fallback, min, max]) => (
          <label key={key} style={{ display: 'block', margin: '10px 0' }}>
            {label}{' '}
            <BudgetNumber
              label={label}
              min={min}
              max={max}
              value={Number(orchestration[key] ?? fallback)}
              disabled={!state.writable || pending}
              save={(value) => save(['orchestration', key], value)}
            />
          </label>
        ))}
      </fieldset>
      <details>
        <summary>开发进度</summary>
        <p>
          比赛工作台支持创建题目、宿主队列、独立复核和
          WP，根目录及并发偏好独立保存。
        </p>
        <GraphPreview />
      </details>
    </section>
  )
}

export function apply(ctx: BrowserContext): void {
  const scope = ctx.configForms.get('sapper')
  const connection = connectPanel(ctx)
  const controller = workbenchController(ctx)
  ctx.effect(() =>
    connection.subscribe(() => {
      const api = connection.getSnapshot().api
      if (api) controller.connect(api)
    }),
  )
  const first = connection.getSnapshot().api
  if (first) controller.connect(first)
  const TaskView = () => {
    const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot)
    return snapshot.api ? (
      <Workbench api={snapshot.api} controller={controller} ctx={ctx} />
    ) : (
      <p role="status">{snapshot.error ?? '正在连接 Sapper 服务…'}</p>
    )
  }
  ctx.effect(() =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: 'sapper',
          label: 'Sapper 比赛工作台',
          order: -10,
        },
        () => <span aria-hidden="true">◈</span>,
      ),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: 'sapper' }, TaskView),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('conversation.input.left', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'sapper-launch',
          label: 'Sapper 任务',
          order: 20,
        },
        () => (
          <button
            type="button"
            aria-label="打开 Sapper 比赛工作台"
            onClick={controller.open}
            style={{
              border: '1px solid #8392a538',
              borderRadius: 8,
              padding: '6px 10px',
              color: 'inherit',
              background: 'transparent',
            }}
          >
            Sapper 任务
          </button>
        ),
      ),
    ),
  )
  if (ctx.uiConversation) {
    ctx.effect(() => ctx.uiConversation!.events.register(resultDefinition))
    ctx.effect(() =>
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register(
          { name: 'conversation.chat.node', key: 'sapper-result' },
          (props: Parameters<typeof ResultNode>[0]) => (
            <ResultNode
              {...props}
              open={() => {
                void controller.reveal(props.node.data)
              }}
            />
          ),
        ),
      ),
    )
  }
  const Panel = ({ view }: { view?: string }) => {
    const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot)
    return view === 'summary' ? (
      <p>工作区事实图与任务规划</p>
    ) : (
      <>
        <button onClick={controller.open} style={{ margin: 16 }}>
          打开 Sapper 比赛工作台 ↗
        </button>
        <SapperSettings scope={scope} api={snapshot.api} />
      </>
    )
  }
  ctx.effect(() => ctx.configForms.whileServed(['sapper'], () => {
    const offCard = ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item', id: 'sapper', label: 'Sapper', order: 100,
    }, Panel))
    const offSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'sapper', label: 'Sapper', order: 100,
    }, Panel))
    return () => { offSettings(); offCard() }
  }), 'sapper: configuration pages')
}
