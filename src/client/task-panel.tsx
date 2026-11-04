import { useCallback, useEffect, useState } from 'react'
import { GraphPreview } from './graph.js'
import { ResultBody } from './result.js'
import type { PanelApi, PanelState, PanelTarget } from '../panel/rpc.js'

const box = { border: '1px solid var(--border-color, #7775)', borderRadius: 8, padding: 12, marginTop: 12 }
const states: Record<string, string> = { stopped: '已停止', running: '运行中', cancelling: '取消中', completed: '已结束', failed: '失败', cancelled: '已取消', active: '进行中', confirmed: '已验证', 'pending-verification': '等待复核' }
export function TaskPanel({ api, sessionId, onJob }: { api: PanelApi; sessionId?: string; onJob?: () => void }) {
  const [direction, setDirection] = useState('')
  const [tab, setTab] = useState('progress'), [reportMessage, setReportMessage] = useState('')
  const [targets, setTargets] = useState<PanelTarget[]>([]), [selected, setSelected] = useState(sessionId ?? '')
  const [state, setState] = useState<PanelState>(), [goal, setGoal] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('')
  useEffect(() => { if (sessionId) setSelected(sessionId) }, [sessionId])
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try { const list = await api.targets(); if (!stopped) { setTargets(list); setSelected(old => sessionId ?? (list.some(t => t.id === old) ? old : list[0]?.id ?? '')) } }
      catch (e) { if (!stopped) setError((e as Error).message) }
      if (!stopped) timer = setTimeout(() => { void load() }, 3000)
    }
    void load(); return () => { stopped = true; clearTimeout(timer) }
  }, [api, sessionId])
  const refresh = useCallback(async () => { if (selected) setState(await api.state(selected)) }, [api, selected])
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>
    setState(undefined)
    const load = async () => {
      if (selected) try { const next = await api.state(selected); if (!stopped) { setState(next); setError('') } } catch (e) { if (!stopped) setError((e as Error).message) }
      if (!stopped) timer = setTimeout(() => { void load() }, 1200)
    }
    void load(); return () => { stopped = true; clearTimeout(timer) }
  }, [api, selected])
  const jobIdentity = state?.job?.id ?? state?.job?.started_at
  useEffect(() => { if (jobIdentity) onJob?.() }, [jobIdentity, onJob])
  const running = state?.job?.state === 'running' || state?.job?.state === 'cancelling'
  const action = async (input: Parameters<PanelApi['action']>[1]) => {
    setPending(true); setError('')
    try { await api.action(selected, input); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setPending(false) }
  }
  return <section aria-label="Sapper 任务面板" style={{ maxWidth: 840, padding: 12, color: 'inherit', overflowWrap: 'anywhere' }}>
    <h3 style={{ marginTop: 0 }}>Sapper 任务</h3>
    <p>在当前工作区输入目标，自动规划、执行并独立复核。</p>
    {!sessionId && <label>工作区会话 <select aria-label="工作区会话" value={selected} disabled={pending || running} onChange={e => setSelected(e.target.value)} style={{ maxWidth: '100%' }}>
      {!targets.length && <option value="">尚无打开的工作区会话</option>}
      {targets.map(t => <option key={t.id} value={t.id}>{t.cwd} · {t.id.slice(0, 8)}</option>)}
    </select></label>}
    {state && <p style={{ fontSize: 12, opacity: .75 }}>{state.cwd}</p>}
    {!selected && <p>在 DSH 打开任意已有目录的对话即可使用。</p>}
    <form onSubmit={e => { e.preventDefault(); e.stopPropagation(); void action({ action: 'start', goal: goal.trim() }) }}>
      <label style={{ display: 'block' }}>任务目标<textarea aria-label="任务目标" placeholder="例如：检查当前项目的构建错误，修复后运行测试并记录结果" rows={3} value={goal} disabled={pending} onChange={e => setGoal(e.target.value)} maxLength={8000} style={{ display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 8, color: 'inherit', background: 'transparent', border: '1px solid #8887', borderRadius: 6 }} /></label>
      <button type="submit" disabled={!selected || !goal.trim() || pending || running}>发起任务</button>{' '}
      {running && <button type="button" disabled={pending || state?.job?.state === 'cancelling'} onClick={() => { void action({ action: 'cancel' }) }}>取消任务</button>}
      <span role="status" style={{ marginLeft: 8 }}>{pending ? '提交中…' : state?.job ? states[state.job.state] : '就绪'}</span>
    </form>
    {error && <p role="alert">{error}</p>}
    {!!state?.warnings?.length && <p role="alert">{state.warnings.join('；')}</p>}
    {state?.job?.error && <p role="alert">{state.job.error}</p>}
    {state?.graph && <div style={box}>
      <strong>{state.graph.goal}</strong>
      <p>{state.graph.status === 'completed' ? '目标已独立验证完成' : '目标待完成'} · 事实 {state.graph.facts} · 已验证 {state.graph.verified} · 待推进 {state.graph.ready}</p>
      {!!state.graph.integrity.length && <p role="alert">{state.graph.integrity.join('；')}</p>}
      {!running && state.graph.status !== 'completed' && <button disabled={pending} onClick={() => { void action({ action: 'resume', task_id: state.active }) }}>继续当前任务</button>}
    </div>}
    {state?.graph && <div style={box}>
      <label>补充方向或后续要求<textarea aria-label="补充方向或后续要求" rows={2} value={direction} onChange={e => setDirection(e.target.value)} style={{ display: 'block', width: '100%', boxSizing: 'border-box', color: 'inherit', background: 'transparent', margin: '8px 0' }} /></label>
      {running ? <button type="button" disabled={pending || !direction.trim() || state.job?.state === 'cancelling'} onClick={() => { void action({ action: 'steer', goal: direction.trim() }) }}>按新方向继续</button> : <>
        <button type="button" disabled={pending} onClick={() => { void action({ action: 'continue', goal: `根据前序证据编写本地 WP，保存为 WP.md；不重新访问外部目标。${direction}`, purpose: 'writeup' }) }}>编写 WP</button>{' '}
        <button type="button" disabled={pending} onClick={() => { void action({ action: 'continue', ...(direction.trim() ? { goal: direction.trim() } : {}), purpose: 'solve' }) }}>重新运行 / 纠正 flag</button>
      </>}
    </div>}
    {state?.graph && <nav aria-label="任务视图" style={{ display: 'flex', gap: 8, marginTop: 16 }}>
      {[['progress','运行进度'],['graph','事实图'],['results','结果与候选']].map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id!)}>{label}</button>)}
      {api.report && !!state.runs.length && <button type="button" disabled={pending} onClick={() => { setPending(true); void api.report!(selected).then(() => setReportMessage('已将完整结果发送到主会话')).catch(e => setError(e.message)).finally(() => setPending(false)) }}>发送结果到主会话</button>}
    </nav>}
    {reportMessage && <p role="status">{reportMessage}</p>}
    {tab === 'graph' && <GraphPreview nodes={state?.graph?.nodes ?? []} />}
    {tab === 'results' && (state?.job?.result ? <ResultBody result={state.job.result} /> : <div>{state?.runs[0]?.outcomes.map((o, i) => <article key={i} style={box}><strong>{o.state === 'confirmed' ? '已复核' : '尚未确认'} · {o.candidate?.title ?? o.intent_id}</strong><pre style={{ whiteSpace: 'pre-wrap' }}>{o.candidate?.description}</pre>{o.error && <p>{o.error}</p>}</article>)}</div>)}
    {tab === 'progress' && !!state?.runs.length && <div style={box}><strong>运行记录</strong>{state.runs.map(run => <details key={run.id} open={run.state === 'running'}>
      <summary>{run.id} · {states[run.state] ?? run.state} · 执行 {run.explored} · {run.children?.at(-1)?.role ?? '准备'}</summary>
      {run.stop_reason && <p>{run.stop_reason}</p>}
      <ol aria-label="子代理执行时间线" style={{ paddingLeft: 24 }}>{run.children?.map(c => <li key={c.session_id} style={{ padding: '8px 0' }}><strong>{{ reason: '规划', explore: '探索', verify: '独立复核' }[c.role]}</strong> · {states[c.state ?? ''] ?? (run.state === 'running' ? '执行中' : '已记录')}
        {c.steps !== undefined && <span> · {c.steps}/{c.step_limit} 步（上限 {c.step_ceiling}）{c.extensions ? ` · 自动延长 ${c.extensions} 次` : ''}{c.finalizing ? ' · 提交结论' : ''}</span>}
      </li>)}</ol>
      {run.outcomes.map((o, i) => <p key={i}>{o.intent_id} · {states[o.state] ?? o.state} {o.candidate?.title}{o.error && `：${o.error}`}{o.verification?.issues && `：${o.verification.issues}`}</p>)}
    </details>)}</div>}
    {!!state?.tasks.length && <details style={box}><summary>工作区任务（{state.tasks.length}）</summary>{[...state.tasks].reverse().map(t => <div key={t.id} style={{ margin: '10px 0' }}>
      <span>{t.id === state.active ? '● ' : ''}{t.goal}</span>{' '}
      <button disabled={pending || running} onClick={() => { void action({ action: 'resume', task_id: t.id }) }}>打开任务</button>
    </div>)}</details>}
  </section>
}


export function TaskDock({ api, sessionId }: { api: PanelApi; sessionId?: string }) {
  const [open, setOpen] = useState(false)
  const revealJob = useCallback(() => setOpen(true), [])
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} style={{ width: '100%' }}>
    <summary style={{ cursor: 'pointer' }}>Sapper 任务</summary>
    <TaskPanel api={api} {...(sessionId ? { sessionId } : {})} onJob={revealJob} />
  </details>
}
