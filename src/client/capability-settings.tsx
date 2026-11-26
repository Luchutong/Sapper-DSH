import { useEffect, useState } from 'react'
import type { Capabilities, ModelCapability } from '../panel/capabilities.js'
import type { WorkbenchPanelApi } from '../panel/rpc.js'
import { EXPLORE_TOOLS, VERIFY_TOOLS, matchesTool, validToolSelector } from '../orchestration/tool-policy.js'

export type SettingValue = boolean | string | number | string[]
const box = { border: '1px solid #71809655', borderRadius: 8, marginTop: 20, padding: 12, minWidth: 0 }
export function EffortSelect({ label, value, model, disabled, inherited = '沿用父会话 / 模型默认', change }: {
  label: string; value: string; model: ModelCapability | undefined; disabled?: boolean; inherited?: string
  change(value: string): void
}) {
  return <label style={{ display: 'block', margin: '10px 0' }}>{label}{' '}
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => change(e.target.value)}>
      <option value="inherit">{inherited}</option>
      {(model?.efforts ?? []).map((e) => <option key={e.id} value={e.id}>{e.name} ({e.id})</option>)}
      {value !== 'inherit' && !model?.efforts.some((e) => e.id === value) && <option value={value}>{value}（当前模型未声明支持）</option>}
    </select>
  </label>
}
export function CapabilitySettings({ api, orchestration, disabled, save, skillMode = false }: {
  api?: Pick<WorkbenchPanelApi, 'capabilities'> | undefined; orchestration: Record<string, unknown>; disabled: boolean
  save(path: string[], value: SettingValue): Promise<boolean>
  skillMode?: boolean
}) {
  const [catalog, setCatalog] = useState<Capabilities>(), [session, setSession] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const load = async (id = session) => {
    if (!api?.capabilities) return
    setLoading(true); setError('')
    try { setCatalog(await api.capabilities(id ? { sessionId: id } : {})) }
    catch (e) { setError((e as Error).message); setCatalog(undefined) }
    finally { setLoading(false) }
  }
  useEffect(() => { let alive = true; if (api?.capabilities) {
    setLoading(true)
    void api.capabilities({}).then((v) => { if (alive) setCatalog(v) }).catch((e) => { if (alive) setError((e as Error).message) }).finally(() => { if (alive) setLoading(false) })
  } return () => { alive = false } }, [api])
  const modelSettings = orchestration.models as Record<string, string> | undefined
  const efforts = orchestration.reasoningEfforts as Record<string, string> | undefined
  const current = catalog?.models.find((m) => m.provider === catalog.currentModel?.provider && m.id === catalog.currentModel?.model)
  return <>
    <fieldset style={box}><legend>工具与模型能力</legend>
      <p>读取 DSH 已注册的能力。选择主会话可检查该工作区及 preset 实际可见范围；列表不代表 MCP 业务调用已成功。</p>
      <label>检查主会话{' '}<select aria-label="检查主会话" value={session} disabled={loading} onChange={(e) => { setSession(e.target.value); void load(e.target.value) }}>
        <option value="">全局注册范围</option>{catalog?.sessions.map((s) => <option key={s.id} value={s.id}>{s.cwd} · {s.id.slice(0, 12)}</option>)}
      </select></label>{' '}<button disabled={loading || !api?.capabilities} onClick={() => { void load() }}>{loading ? '正在读取…' : '刷新能力'}</button>
      {error && <p role="alert">{error}</p>}
      {!api?.capabilities && <p role="status">正在连接 Sapper 工具目录…</p>}
      {catalog?.warnings.map((w) => <p key={w}>{w}</p>)}
      {!skillMode && <><p>连接、凭据、工作区范围和按会话启用仍在 MCP 连接器中管理。Sapper 只配置子代理使用范围，不会启用被宿主或连接器拒绝的工具。</p>
      {(['explore', 'verify'] as const).map((role) => <ToolRange key={role} role={role} catalog={catalog} disabled={disabled}
        selected={(orchestration[role + 'Tools'] as string[] | undefined) ?? (role === 'explore' ? EXPLORE_TOOLS : VERIFY_TOOLS)}
        save={(value) => save(['orchestration', role + 'Tools'], value)} />)}</>}
    </fieldset>
    <fieldset style={box}><legend>模型与默认推理强度</legend>
      <p>选项来自 DSH 模型适配器。角色设置优先于下方默认值；默认值为“沿用”时由父会话或模型决定。更换模型后不沿用其他模型的档位。</p>
      <p>检查范围的模型：{catalog?.currentModel ? `${catalog.currentModel.provider} / ${catalog.currentModel.model}` : '尚未取得模型'}；会话档位：{catalog?.currentModel?.reasoningEffort ?? '模型默认'}</p>
      <EffortSelect label="默认推理强度" value={String(orchestration.reasoningEffort ?? 'inherit')} model={current} disabled={disabled}
        change={(v) => { void save(['orchestration', 'reasoningEffort'], v) }} />
      {(['reason', 'explore', 'verify'] as const).map((role) => {
        const value = modelSettings?.[role] ?? 'inherit', route = value === 'inherit' ? current : catalog?.models.find((m) => `${m.provider}:${m.id}` === value || (m.provider === current?.provider && m.id === value))
        return <details key={role}><summary>{({ reason: '规划', explore: '探索', verify: '独立复核' })[role]}模型与推理强度</summary>
          <label>角色模型{' '}<select aria-label={`${role} 模型`} value={value} disabled={disabled} onChange={(e) => { void save(['orchestration', 'models', role], e.target.value) }}>
            <option value="inherit">沿用父会话</option>{catalog?.models.map((m) => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.provider} / {m.name}</option>)}
            {value !== 'inherit' && !catalog?.models.some((m) => `${m.provider}:${m.id}` === value) && <option value={value}>{value}（自定义）</option>}
          </select></label>
          <EffortSelect label={`${role} 推理强度`} value={efforts?.[role] ?? 'inherit'} model={route} disabled={disabled} inherited="沿用 Sapper 默认值"
            change={(v) => { void save(['orchestration', 'reasoningEfforts', role], v) }} />
        </details>
      })}
    </fieldset>
  </>
}
function ToolRange({ role, selected, catalog, disabled, save }: { role: 'explore' | 'verify'; selected: string[]; catalog: Capabilities | undefined; disabled: boolean; save(value: string[]): Promise<boolean> }) {
  const serialized = JSON.stringify(selected), [draft, setDraft] = useState(selected), [filter, setFilter] = useState(''), [manual, setManual] = useState('')
  useEffect(() => setDraft(JSON.parse(serialized) as string[]), [serialized])
  const toggle = (name: string) => setDraft((all) => all.includes(name) ? all.filter((s) => s !== name) : [...all, name])
  const tools = catalog?.tools ?? [], prefixes = [...new Set(tools.flatMap((t) => t.prefix ? [t.prefix] : []))]
  const unknown = draft.filter((s) => !tools.some((t) => matchesTool([s], t.name)))
  return <details open style={{ marginTop: 16 }}><summary>{role === 'explore' ? '探索' : '独立复核'}工具范围 · {tools.filter((t) => t.available && matchesTool(draft, t.name)).length} 项可见</summary>
    <label style={{ display: 'block', margin: '10px 0' }}><input type="checkbox" aria-label={`${role} 全部 MCP`} checked={draft.includes('mcp__*')} disabled={disabled} onChange={() => toggle('mcp__*')} /> 使用父会话允许的全部 MCP 工具（包括后续注册）</label>
    <details><summary>按 MCP 命名前缀选择</summary>{prefixes.map((p) => <label key={p} style={{ display: 'block' }}><input type="checkbox" aria-label={`${role} ${p}`} checked={draft.includes(p) || draft.includes('mcp__*')} disabled={disabled || draft.includes('mcp__*')} onChange={() => toggle(p)} />{p}</label>)}</details>
    <input aria-label={`${role} 搜索工具`} placeholder="搜索工具名称或描述" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '95%', marginTop: 8 }} />
    <div style={{ maxHeight: 280, overflow: 'auto', margin: '8px 0' }}>{tools.filter((t) => (t.name + t.description).toLowerCase().includes(filter.toLowerCase())).map((t) => {
      const inherited = draft.some((s) => s.endsWith('*') && matchesTool([s], t.name))
      return <label key={t.name} style={{ display: 'block', padding: '5px 0', overflowWrap: 'anywhere', opacity: t.available ? 1 : .6 }}><input type="checkbox" aria-label={`${role} ${t.name}`} checked={matchesTool(draft, t.name)} disabled={disabled || inherited} onChange={() => toggle(t.name)} /> {t.name}{inherited ? ' · 按前缀包含' : ''}{!t.available ? ' · 父会话不可见' : ''}<small style={{ display: 'block' }}>{t.description}</small></label>
    })}</div>
    <details><summary>已选范围与未匹配项</summary>{draft.map((s) => <div key={s}><code>{s}</code>{unknown.includes(s) ? ' · 当前范围未匹配' : ''} <button disabled={disabled} onClick={() => toggle(s)}>移除 {s}</button></div>)}
      <label>添加精确名称或 MCP 前缀 <input aria-label={`${role} 添加工具范围`} value={manual} onChange={(e) => setManual(e.target.value)} /></label><button disabled={disabled || !validToolSelector(manual.trim())} onClick={() => { if (!draft.includes(manual.trim())) setDraft([...draft, manual.trim()]); setManual('') }}>添加范围</button>
    </details>
    <button disabled={disabled || JSON.stringify(draft) === serialized} onClick={() => { void save(draft) }}>保存{role === 'explore' ? '探索' : '复核'}工具范围</button>
  </details>
}
