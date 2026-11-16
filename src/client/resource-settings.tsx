import { useEffect, useState } from 'react'
import type { ChildCapabilities } from '../store/runs.js'
import type { BrokerPolicy, BrokerSnapshot, ToolProfile } from '../mcp/contracts.js'
import type { WorkbenchPanelApi } from '../panel/rpc.js'
export type BrokerApi = Pick<WorkbenchPanelApi, 'brokerState' | 'brokerConfigure' | 'brokerReset'>
const split = (value: string) => value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
const box = { border: '1px solid #71809655', borderRadius: 8, padding: 12, marginTop: 16, minWidth: 0 }
export function ResourceSettings({ api, readOnly = false, ownerIds, address, history }: { history?: ChildCapabilities[] | undefined; api?: BrokerApi | undefined; readOnly?: boolean; ownerIds?: string[] | undefined; address?: { workspaceId: string; taskId: string; runId?: string | undefined } | undefined }) {
  const [snapshot, setSnapshot] = useState<BrokerSnapshot>(), [draft, setDraft] = useState<BrokerPolicy>(), [revision, setRevision] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false), [raw, setRaw] = useState(''), [confirm, setConfirm] = useState('')
  const load = async (reload = false) => {
    if (!api?.brokerState) return
    try { const next = await api.brokerState(); setSnapshot(next); setError(''); if (!draft || reload) { setDraft(next.policy); setRevision(next.revision); setRaw(JSON.stringify(next.policy, null, 2)) } }
    catch (e) { setError((e as Error).message) }
  }
  useEffect(() => {
    let active = true
    const fetch = async () => { try { const value = await api?.brokerState?.(); if (active && value) { setSnapshot(value); setDraft(value.policy); setRevision(value.revision); setRaw(JSON.stringify(value.policy, null, 2)); setError('') } } catch (e) { if (active) setError((e as Error).message) } }
    void fetch()
    const timer = setInterval(() => { void api?.brokerState?.().then((v) => { if (active) setSnapshot(v) }).catch(() => {}) }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [api])
  const change = (policy: BrokerPolicy) => { setDraft(policy); setRaw(JSON.stringify(policy, null, 2)) }
  const edit = (index: number, update: Partial<ToolProfile>) => { if (draft) change({ ...draft, profiles: draft.profiles.map((p, i) => i === index ? { ...p, ...update } : p) }) }
  const save = async (policy = draft) => {
    if (!policy || !api?.brokerConfigure) return
    setBusy(true); setError('')
    try { const value = await api.brokerConfigure({ revision, policy }); setSnapshot(value); change(value.policy); setRevision(value.revision) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (address) ownerIds = [...new Set([...(ownerIds ?? []), ...(snapshot?.owners ?? []).filter((o) => o.workspaceId === address.workspaceId && o.taskId === address.taskId && (!address.runId || o.runId === address.runId)).map((o) => o.agentId)])]
  const leases = snapshot?.leases.filter((l) => !ownerIds || ownerIds.includes(l.ownerId)) ?? []
  return <fieldset style={box}><legend>工具与资源隔离</legend>
    <p>按当前工作区、父会话与角色选取工具；共享状态按整个工作流协调。未分类 MCP 共用一个保守串行域。</p>
    {!api?.brokerState && <p>正在连接工具资源服务…</p>}
    <button type="button" disabled={busy || !api?.brokerState} onClick={() => { void load(true) }}>刷新并重新载入策略</button>
    {error && <p role="alert">{error}</p>}
    {snapshot?.warnings.map((w) => <p key={w} style={{ opacity: .8 }}>{w}</p>)}
    <div role="status">{snapshot ? `等待 ${snapshot.waiting.length} · 活跃 ${leases.filter((l) => l.state === 'active').length} · 隔离 ${leases.filter((l) => l.state === 'quarantined').length}` : '正在读取资源…'}</div>
    {snapshot?.waiting.filter((w) => !ownerIds || ownerIds.includes(w.ownerId)).map((w) => <p key={w.id}>等待资源：{w.keys.join('、')} · {w.ownerId.slice(0, 12)}</p>)}
    {leases.filter((l) => l.state !== 'released').map((l) => <article style={box} key={l.id}>
      <strong>{l.backendId}</strong> · {l.state === 'active' ? '工作流占用' : l.state === 'quarantined' ? '已隔离，待核实' : l.state} · {({ serialized: '当前宿主串行', process: '专属进程', 'verified-handle': '已核验句柄' })[l.assurance]}
      <p>Agent {l.ownerId.slice(0, 12)} · 实例槽 {l.slot + 1} · epoch {l.epoch}</p>{l.error && <p>{l.error}</p>}
      {l.state === 'quarantined' && !readOnly && <><label><input type="checkbox" aria-label={`确认后端已重置 ${l.key}`} checked={confirm === l.key} onChange={(e) => setConfirm(e.target.checked ? l.key : '')} />我已核实旧操作停止并重置实际后端</label>{' '}<button disabled={confirm !== l.key || busy || !api?.brokerReset} onClick={() => { setBusy(true); void api?.brokerReset?.({ key: l.key, confirmed: true }).then((v) => { setSnapshot(v); setConfirm('') }).catch((e) => setError((e as Error).message)).finally(() => setBusy(false)) }}>解除该资源隔离</button></>}
    </article>)}
    {!readOnly && draft && <>
      <p>资源策略独立保存，不停止无关任务；修改正在占用的配置组后，新调用会要求重新绑定。权限与连接器激活仍由 DSH 管理。</p>
      <label>工具选择 <select aria-label="资源工具选择" value={draft.selection} onChange={(e) => change({ ...draft, selection: e.target.value as 'auto' | 'all' })}><option value="auto">按意图能力自动选择</option><option value="all">使用作用域内全部已选工具</option></select></label>
      <label style={{ display: 'block' }}>单次工具调用排队上限（秒） <input aria-label="资源等待秒数" type="number" min={1} max={3600} value={Math.round(draft.waitMs / 1000)} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 3600) change({ ...draft, waitMs: n * 1000 }) }} /></label>
      {draft.profiles.map((p, i) => <details style={box} key={p.id} open><summary>{p.label} · {p.backendId}</summary>
        <label>名称 <input aria-label={`资源名称 ${i}`} value={p.label} onChange={(e) => edit(i, { label: e.target.value })} /></label>
        <label style={{ display: 'block' }}>物理后端 ID <input aria-label={`物理后端 ${i}`} value={p.backendId} onChange={(e) => edit(i, { backendId: e.target.value })} /></label>
        <small>同一 IDA 的不同连接别名必须填写同一后端 ID。</small>
        <label style={{ display: 'block' }}>MCP 工具范围 <ListInput label={`资源工具范围 ${i}`} values={p.selectors} change={(value) => edit(i, { selectors: value })} /></label>
        <label style={{ display: 'block' }}>能力 ID <ListInput label={`资源能力 ${i}`} values={p.capabilities} change={(value) => edit(i, { capabilities: value })} /></label>
        <label style={{ display: 'block' }}>工作区 ID（空为所有已授权工作区） <ListInput label={`资源工作区 ${i}`} values={p.workspaceIds} change={(value) => edit(i, { workspaceIds: value })} /></label>
        <label>隔离策略 <select aria-label={`资源隔离策略 ${i}`} value={p.isolation} onChange={(e) => edit(i, { isolation: e.target.value as ToolProfile['isolation'] })}><option value="exclusive-workflow">共享后端：整个工作流独占</option><option value="stateless">已确认无状态：仅限制调用并发</option><option value="dedicated-instance">专属实例（需提供者）</option><option value="explicit-handle">独立句柄（需提供者）</option></select></label>
        {['dedicated-instance', 'explicit-handle'].includes(p.isolation) && <><label>实例提供者 <select aria-label={`实例提供者 ${i}`} value={p.providerId ?? ''} onChange={(e) => edit(i, { providerId: e.target.value })}><option value="">选择已注册提供者</option>{snapshot?.providers.map((id) => <option key={id}>{id}</option>)}</select></label><label>实例数 <input type="number" min={1} max={32} value={p.maxInstances} onChange={(e) => edit(i, { maxInstances: Number(e.target.value) })} /></label></>}
        <label style={{ display: 'block' }}>单实例调用并发 <input aria-label={`资源调用并发 ${i}`} type="number" min={1} max={32} value={p.maxInFlight} onChange={(e) => edit(i, { maxInFlight: Number(e.target.value) })} /></label>
        {(['explore', 'verify'] as const).map((role) => <label key={role}><input type="checkbox" aria-label={`${role} 资源角色 ${i}`} checked={p.roles.includes(role)} onChange={(e) => edit(i, { roles: e.target.checked ? [...p.roles, role] : p.roles.filter((r) => r !== role) })} />{role === 'explore' ? '探索' : '独立复核'} </label>)}
        <button type="button" onClick={() => change({ ...draft, profiles: draft.profiles.filter((_, n) => n !== i) })}>移除资源组</button>
      </details>)}
      <button type="button" onClick={() => change({ ...draft, profiles: [...draft.profiles, { id: 'resource-' + Date.now(), label: '共享 IDA', backendId: 'ida-local', selectors: ['mcp__ida__*'], capabilities: ['binary.inspect', 'binary.decompile'], roles: ['explore', 'verify'], workspaceIds: [], isolation: 'exclusive-workflow', maxInstances: 1, maxInFlight: 1, effects: {}, measurements: [], targetTools: [], bindings: {} }] })}>添加资源配置组</button>{' '}
      <button type="button" disabled={busy || !api?.brokerConfigure || JSON.stringify(draft) === JSON.stringify(snapshot?.policy)} onClick={() => { void save() }}>保存资源策略</button>
      <details><summary>高级 JSON：身份校验、工具效应与适配器</summary><p>仅修改本地策略，不创建 MCP 连接，不复制凭据。远端 readOnlyHint 不作为并发保证。</p><textarea aria-label="资源策略 JSON" style={{ width: '100%', minHeight: 220, fontFamily: 'monospace' }} value={raw} onChange={(e) => setRaw(e.target.value)} /><button type="button" disabled={busy} onClick={() => { try { void save(JSON.parse(raw) as BrokerPolicy) } catch (e) { setError((e as Error).message) } }}>校验并保存 JSON</button></details>
    </>}
    {!!history?.length && <details><summary>所选执行的资源与观测历史</summary><p>以下为当时快照；历史动态地址不代表当前进程仍可使用。</p>{history.map((child) => <details key={child.session_id}><summary>{child.role} · {child.session_id.slice(0, 12)} · {child.tool_broker?.receipts.length ?? 0} 个回执</summary>
      {child.tool_broker?.selection.excluded.map((x) => <p key={x.name}>{x.name} · {x.reason}</p>)}
      {child.tool_broker?.observations.map((o) => <details key={o.observationId}><summary>{o.claim} · {o.basis === 'tool-parsed' ? '工具测量' : '代理推断'} · {o.currentlyApplicable ? '当时范围匹配' : '需重新检查范围'}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(o.value, null, 2)}</pre><p>{o.invalidReason}</p></details>)}
      {child.tool_broker?.repairPlans.map((p) => <p key={p.planId}>恢复建议：{p.reason} · {p.resumeFrom} · 下一能力 {p.nextCapability}</p>)}
      <small>完整原始调用与协议回执位于本题 .sapper 的 artifacts/tools 目录，可在“文件”页预览。</small>
    </details>)}</details>}
    <details><summary>最近工具回执</summary>{snapshot?.receipts.filter((r) => !ownerIds || ownerIds.includes(r.owner.agentId)).slice(-20).reverse().map((r) => <p key={r.receiptId}>{r.toolRef.publicName} · {r.status} · {r.target.binding === 'attested' ? '目标已核对' : '目标身份未认证'} · {r.owner.runId ?? '主会话'}</p>)}</details>
  </fieldset>
}

function ListInput({ label, values, change }: { label: string; values: string[]; change(value: string[]): void }) {
  const serialized = JSON.stringify(values), [text, setText] = useState(values.join(', '))
  useEffect(() => setText((JSON.parse(serialized) as string[]).join(', ')), [serialized])
  return <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => change(split(text))} />
}
