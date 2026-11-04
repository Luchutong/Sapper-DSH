import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserContext } from '../dsh-adapter/client.js'
import type { WorkbenchPanelApi, PanelAction } from '../panel/rpc.js'
import type {
  Challenge,
  LaunchInput,
  LaunchRecord,
  TaskAddress,
  TaskDetail,
  WorkbenchSnapshot,
} from '../workbench/contracts.js'
import type { WorkbenchController } from './workbench-store.js'
import { workbenchStyle } from './workbench-style.js'
import { GraphPreview } from './graph.js'
import { DirectoryPicker } from './directory-picker.js'
import { candidateLabel } from './result.js'
import { launchWithAttachments, type DraftAttachment } from './launch-attachments.js'

const labels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  cancelling: '正在停止',
  completed: '本轮已结束',
  confirmed: 'flag 已独立复核',
  candidate: '候选 flag，尚未复核',
  failed: '执行失败',
  cancelled: '已停止',
  interrupted: '已中断',
  idle: '本轮结束，待继续',
  rejected: '复核未通过',
}
const Badge = ({ state, label }: { state: string; label?: string }) => (
  <span className="sp-badge" data-state={state}>
    {label ?? labels[state] ?? state}
  </span>
)
const active = (c: Challenge) =>
  ['running', 'cancelling', 'queued'].includes(c.state)
function elapsed(created: string, end?: string) {
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(created)
  return Number.isFinite(ms)
    ? Math.max(0, Math.round(ms / 60000)) + ' 分钟'
    : '—'
}
export function Workbench({
  api,
  controller,
  ctx,
}: {
  api: WorkbenchPanelApi
  controller: WorkbenchController
  ctx: BrowserContext
}) {
  const { data, error, selected } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [creating, setCreating] = useState(false),
    [actionError, setActionError] = useState(''),
    [resume, setResume] = useState<LaunchRecord>()
  const challenge = data?.challenges.find((c) => c.id === selected)
  const choose = (c: Challenge) => {
    controller.select(c)
    setCreating(false)
    setActionError('')
  }
  const list =
    data?.challenges.filter(
      (c) =>
        (c.title + c.goal).toLowerCase().includes(search.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'running' &&
            ['running', 'cancelling'].includes(c.state)) ||
          (filter === 'queued' && c.state === 'queued') ||
          (filter === 'ended' && !active(c))),
    ) ?? []
  return (
    <section className="sp-workbench" aria-label="Sapper 比赛工作台">
      <style>{workbenchStyle}</style>
      <header className="sp-toolbar">
        <div>
          <h1>Sapper 比赛工作台</h1>
          <small>规划、探索、复核与 WP，按题目集中管理</small>
        </div>
        <div className="sp-actions">
          <label>
            同时执行{' '}
            <select
              aria-label="同时执行题数"
              value={data?.preferences.parallelism ?? 2}
              disabled={!data}
              onChange={(e) => {
                if (data)
                  void api
                    .preferences({
                      ...data.preferences,
                      parallelism: Number(e.target.value),
                    })
                    .then(controller.refresh)
                    .catch((e) => setActionError(e.message))
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            className="sp-primary"
            onClick={() => {
              setResume(undefined)
              setCreating(true)
            }}
          >
            ＋ 新建题目
          </button>
        </div>
      </header>
      {(error || actionError) && (
        <p className="sp-error" role="alert">
          {actionError || error}
        </p>
      )}
      <div className="sp-body" data-selected={Boolean(challenge) || creating}>
        <aside className="sp-list" aria-label="题目列表">
          <input
            aria-label="搜索题目"
            placeholder="搜索题名或目标"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <nav className="sp-filters">
            {[
              ['all', '全部'],
              ['running', '运行中'],
              ['queued', '排队'],
              ['ended', '已结束'],
            ].map(([key, title]) => (
              <button
                key={key}
                aria-pressed={filter === key}
                onClick={() => setFilter(key!)}
              >
                {title}
              </button>
            ))}
          </nav>
          {list.map((c) => (
            <button
              className="sp-task"
              key={c.id}
              aria-pressed={selected === c.id && !creating}
              onClick={() => choose(c)}
            >
              <strong>
                {c.title}
                {c.unread && (
                  <span className="sp-unread" aria-label="未读结果" />
                )}
              </strong>
              <span className="sp-goal">{c.goal}</span>
              <span className="sp-goal">
                {active(c) ? c.job?.stage : undefined}
              </span>
              <span className="sp-task-meta">
                <Badge state={c.state} />
                <span>
                  {elapsed(c.createdAt, active(c) ? undefined : c.updatedAt)}
                </span>
              </span>
            </button>
          ))}
          {data?.launches
            ?.filter((l) => !l.jobId)
            .map((l) => (
              <button
                key={l.requestId}
                className="sp-task"
                onClick={() => {
                  setResume(l)
                  setCreating(true)
                }}
              >
                <strong>{l.title}</strong>
                <span className={l.error ? 'sp-error' : 'sp-muted'}>创建未完成，点击恢复</span>
              </button>
            ))}
          {!list.length && (
            <p className="sp-muted">
              {data
                ? '没有匹配的题目。选择比赛目录即可新建。'
                : '正在加载题目…'}
            </p>
          )}
        </aside>
        <main className="sp-detail">
          {creating && data ? (
            <NewChallenge
              key={resume?.requestId ?? 'new'}
              initial={resume}
              data={data}
              api={api}
              ctx={ctx}
              done={async () => {
                setCreating(false)
                await controller.refresh()
              }}
              close={() => setCreating(false)}
            />
          ) : challenge ? (
            <Details
              challenge={challenge}
              api={api}
              controller={controller}
              ctx={ctx}
              back={() => controller.select()}
            />
          ) : (
            <div className="sp-empty">
              <h2>开始下一道题</h2>
              <p>选择比赛根目录，输入目标；自动创建独立工作区和主会话。</p>
              <button
                className="sp-primary"
                onClick={() => {
                  setResume(undefined)
                  setCreating(true)
                }}
              >
                新建题目
              </button>
            </div>
          )}
        </main>
      </div>
    </section>
  )
}
function NewChallenge({
  data,
  api,
  ctx,
  done,
  close,
  initial,
}: {
  initial: LaunchRecord | undefined
  data: WorkbenchSnapshot
  api: WorkbenchPanelApi
  ctx: BrowserContext
  done: () => Promise<void>
  close: () => void
}) {
  const saved = data.preferences,
    [rootDir, setRoot] = useState(initial?.input.rootDir ?? saved.rootDir),
    [title, setTitle] = useState(initial?.input.title ?? ''),
    [goal, setGoal] = useState(initial?.input.goal ?? ''),
    [permission, setPermission] = useState(
      initial?.input.permissionPreset ?? saved.permissionPreset ?? data.defaults.permissionPreset ?? '',
    ),
    [preset, setPreset] = useState(
      initial?.input.agentPreset ?? saved.agentPreset ?? data.defaults.agentPreset ?? '',
    ),
    [provider, setProvider] = useState(
      initial?.input.model?.provider ?? saved.model?.provider ?? data.defaults.model?.provider ?? '',
    ),
    [model, setModel] = useState(
      initial?.input.model?.model ?? saved.model?.model ?? data.defaults.model?.model ?? '',
    ),
    [pending, setPending] = useState(false),
    [error, setError] = useState(initial?.error ?? ''),
    [picking, setPicking] = useState(false),
    [files, setFiles] = useState<DraftAttachment[]>(() => (initial?.input.attachments ?? []).map((f) => ({ ...f, stage: initial?.files?.find((saved) => saved.id === f.id)?.sha256 ? 'ready' : 'selected' }))),
    [request, setRequest] = useState<LaunchInput | undefined>(initial?.input)
  const transfer = useRef<AbortController>()
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false; transfer.current?.abort() }, [])
  const launch = async () => {
    setPending(true)
    setError('')
    const controller = new AbortController()
    transfer.current = controller
    const input = request ?? {
      requestId: crypto.randomUUID(),
      rootDir,
      title,
      goal,
      ...(files.length ? { attachments: files.map(({ id, name, bytes }) => ({ id, name, bytes })) } : {}),
      ...(permission ? { permissionPreset: permission } : {}),
      ...(preset ? { agentPreset: preset } : {}),
      ...(provider && model
        ? {
            model: {
              provider,
              model,
              ...(saved.model?.reasoningEffort
                ? { reasoningEffort: saved.model.reasoningEffort }
                : {}),
            },
          }
        : {}),
    }
    setRequest(input)
    try {
      await api.preferences({
        ...saved,
        rootDir: input.rootDir,
        ...(input.model ? { model: input.model } : {}),
        ...(input.permissionPreset
          ? { permissionPreset: input.permissionPreset }
          : {}),
        ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
      })
      await launchWithAttachments(api, ctx, input, files, controller.signal, (progress) => {
        if (mounted.current && (!controller.signal.aborted || progress.stage === 'failed')) setFiles((all) => all.map((f) => f.id === progress.id ? { ...f, ...progress } : f))
      }, async (record) => {
        if (!mounted.current) return
        await done()
        if (record.sessionId) ctx.uiWorkspace?.openSession(record.sessionId)
      })
    } catch (e) {
      if (mounted.current) setError((e as Error).message)
    } finally {
      if (mounted.current) setPending(false)
    }
  }
  return (
    <section className="sp-start" aria-label="新建题目">
      <h2>新建题目</h2>
      <p className="sp-muted">每题一个目录与主会话；后台排队，不占用输入框。</p>
      <fieldset
        disabled={pending || Boolean(request)}
        style={{ border: 0, padding: 0 }}
      >
        <label>
          比赛根目录
          <div className="sp-form-row">
            <input
              aria-label="比赛根目录"
              placeholder="首次选择后会记住"
              value={rootDir}
              onChange={(e) => setRoot(e.target.value)}
            />
            <button
              disabled={!ctx.uiWorkspace || picking}
              onClick={() => {
                setError('')
                setPicking(true)
              }}
            >
              选择文件夹
            </button>
          </div>
        </label>
        {picking && ctx.uiWorkspace && <DirectoryPicker
          workspace={ctx.uiWorkspace}
          initialPath={rootDir}
          onPicked={setRoot}
          onClose={() => setPicking(false)}
        />}
        <label>
          题名（可选）
          <input
            aria-label="题名"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          任务目标
          <textarea
            aria-label="任务目标"
            autoFocus
            placeholder="例如：分析附件，寻找 flag 并保存可复现证据"
            value={goal}
            maxLength={8000}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <div className="sp-form-row">
          <label>
            权限
            <select
              aria-label="任务权限"
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
            >
              <option value="">沿用 DSH 默认</option>
              {data.defaults.permissions.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Agent preset
            <select
              aria-label="任务 preset"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
            >
              <option value="">沿用 DSH 默认</option>
              {data.defaults.presets.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        </div>
        <details>
          <summary>
            模型：
            {provider && model ? provider + ' / ' + model : 'DSH 当前默认'}
          </summary>
          <label>
            Provider
            <input
              aria-label="模型 provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
          </label>
          <label>
            模型
            <input
              aria-label="模型"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
        </details>
      </fieldset>
      <fieldset disabled={pending} className="sp-attachment-picker">
        <legend>题目附件（可选）</legend>
        <p className="sp-muted">ZIP、程序、图片等文件会原样保存到本题 attachments 文件夹；全部保存后才开始任务。</p>
        {!request && <label>
          添加附件
          <input aria-label="添加题目附件" type="file" multiple disabled={!ctx.fileUpload || data.uploadAvailable === false} onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? [])
            if (selected.length + files.length > 128) { setError('每题最多添加 128 个附件'); return }
            setFiles((all) => [...all, ...selected.map((file) => ({ id: crypto.randomUUID(), name: file.name, bytes: file.size, file, stage: 'selected' as const }))])
            event.currentTarget.value = ''
          }} />
        </label>}
        {(!ctx.fileUpload || data.uploadAvailable === false) && <p role="status">DSH 文件上传服务尚未就绪，仍可不带附件创建。</p>}
        <ul className="sp-attachments">
          {files.map((file) => <li key={file.id}>
            <strong>{file.name}</strong> <small>{file.bytes.toLocaleString()} 字节</small>
            <p role="status">{file.stage === 'ready' ? '已保存' : file.stage === 'uploading' ? `正在上传 ${file.loaded ?? 0} / ${file.bytes} 字节` : file.stage === 'saving' ? '正在保存到题目目录…' : file.stage === 'failed' ? file.error : file.file ? '等待上传' : '需重新选择此附件以继续上传'}</p>
            {(file.stage === 'uploading' || file.stage === 'saving') && <progress aria-label={`${file.name} 上传进度`} value={file.loaded ?? 0} max={file.bytes || 1} />}
            {!request ? <button type="button" onClick={() => setFiles((all) => all.filter((f) => f.id !== file.id))}>移除 {file.name}</button> : file.stage !== 'ready' && <label>
              重新选择 {file.name}
              <input type="file" aria-label={`重新选择 ${file.name}`} onChange={(event) => {
                const selected = event.currentTarget.files?.[0]
                if (!selected) return
                if (selected.name !== file.name || selected.size !== file.bytes) { setError(`请选择同名且同大小的原附件：${file.name}`); return }
                setFiles((all) => all.map((f) => f.id === file.id ? { ...f, file: selected, stage: 'selected', error: undefined } : f))
              }} />
            </label>}
          </li>)}
        </ul>
      </fieldset>
      {error && (
        <p role="alert" className="sp-error">
          {error}。已创建的内容会保留，重试将继续同一请求。
        </p>
      )}
      {!data.available && <p role="status">等待 DSH 原生工作区与会话服务…</p>}
      {!data.durable && <p role="status">等待持久化存储，连接完成后可创建。</p>}
      <div className="sp-actions">
        <button
          className="sp-primary"
          disabled={
            pending ||
            picking ||
            !goal.trim() ||
            !rootDir ||
            !data.available ||
            !data.durable
          }
          onClick={() => {
            void launch()
          }}
        >
          {pending ? '正在创建…' : request ? '继续创建' : '创建并开始'}
        </button>
        {request && (
          <button
            onClick={() => {
              setRequest(undefined)
              setFiles((all) => all.filter((f) => f.file).map((f) => ({ ...f, id: crypto.randomUUID(), stage: 'selected', loaded: 0, error: undefined })))
              setError('')
            }}
            disabled={pending}
          >
            另建题目
          </button>
        )}
        {pending && files.some((f) => f.stage === 'uploading' || f.stage === 'saving') && <button onClick={() => transfer.current?.abort()}>取消上传</button>}
        <button onClick={close} disabled={pending}>
          返回列表
        </button>
      </div>
    </section>
  )
}
function Details({
  challenge: c,
  api,
  controller,
  ctx,
  back,
}: {
  challenge: Challenge
  api: WorkbenchPanelApi
  controller: WorkbenchController
  ctx: BrowserContext
  back: () => void
}) {
  const [tab, setTab] = useState('概览'),
    [phase, setPhase] = useState(c.phases.at(-1)?.taskId ?? c.taskId),
    [run, setRun] = useState(''),
    [detail, setDetail] = useState<TaskDetail>(),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [followPhase, setFollowPhase] = useState(false),
    [direction, setDirection] = useState(''),
    [file, setFile] = useState<{
      name: string
      text: string
      truncated: boolean
    }>()
  useEffect(() => {
    setPhase(c.phases.at(-1)?.taskId ?? c.taskId)
    setRun('')
    setDetail(undefined)
    setFile(undefined)
  }, [c.id])
  useEffect(() => {
    if (c.phases.length && !c.phases.some((p) => p.taskId === phase)) {
      setPhase(c.phases.at(-1)!.taskId)
      setRun('')
    }
  }, [c.phases, phase])
  useEffect(() => {
    if (followPhase && c.phases.length && c.phases.at(-1)!.taskId !== phase) {
      setPhase(c.phases.at(-1)!.taskId)
      setRun('')
      setDetail(undefined)
      setFile(undefined)
      setFollowPhase(false)
    }
  }, [followPhase, c.phases, phase])
  const address: TaskAddress = {
    workspaceId: c.workspaceId,
    taskId: phase,
    ...(run ? { runId: run } : {}),
  }
  useEffect(() => {
    let live = true
    const read = () =>
      api
        .detail(address)
        .then((d) => {
          if (live) {
            setDetail(d)
            setError('')
          }
        })
        .catch((e) => {
          if (live) setError(e.message)
        })
    void read()
    const timer = setInterval(() => {
      void read()
    }, 2000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [api, c.workspaceId, phase, run])
  const act = async (action: PanelAction) => {
    setPending(true)
    setError('')
    try {
      await api.taskAction(address, action)
      if (action.action === 'continue' || action.action === 'steer')
        setFollowPhase(true)
      await controller.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }
  const current = detail?.state.runs[0],
    brief =
      c.job &&
      controller.getSnapshot().data?.briefs.find((b) => b.jobId === c.job!.id)
  const inspect = useCallback(
    (id: string) => api.node({ workspaceId: c.workspaceId, taskId: phase }, id),
    [api, c.workspaceId, phase],
  )
  const openFile = async (name: string) => {
    try {
      setFile({ name, ...(await api.file(address, name)) })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <header className="sp-detail-head">
        <button className="sp-back" onClick={back}>
          ← 题目列表
        </button>
        <h2>{c.title}</h2>
        <p>
          <Badge state={c.state} />{' '}
          <small>
            {c.phases.length} 个阶段 ·{' '}
            {elapsed(c.createdAt, active(c) ? undefined : c.updatedAt)}
          </small>
        </p>
        <div className="sp-actions">
          <button
            disabled={!c.sessionId}
            onClick={() => ctx.uiWorkspace?.openSession(c.sessionId)}
          >
            打开主会话 ↗
          </button>
          {active(c) ? (
            <button
              disabled={pending}
              onClick={() => {
                void act({ action: 'cancel' })
              }}
            >
              {c.state === 'queued' ? '取消排队' : '停止任务'}
            </button>
          ) : (
            <>
              {!c.phases.length ? (
                <button
                  disabled={pending}
                  onClick={() => {
                    void act({ action: 'start', goal: c.goal })
                  }}
                >
                  重新开始
                </button>
              ) : (
                <>
                  <button
                    disabled={pending}
                    onClick={() => {
                      void act({
                        action: 'continue',
                        purpose: 'writeup',
                        goal: '基于本题历史证据编写或更新本地 WP.md，清晰标注 flag 在生成时的验证状态，独立读取文件复核内容。',
                      })
                    }}
                  >
                    编写 WP
                  </button>
                  <button
                    disabled={pending}
                    onClick={() => {
                      void act({ action: 'resume' })
                    }}
                  >
                    继续当前阶段
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <nav className="sp-tabs" role="tablist">
          {['概览', '执行记录', '证据', '事实图', '文件'].map((t) => (
            <button
              role="tab"
              aria-selected={tab === t}
              key={t}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <div className="sp-content">
        {error && (
          <p className="sp-error" role="alert">
            {error}
          </p>
        )}
        {c.error && <p role="alert">{c.error}</p>}
        <div className="sp-form-row">
          <label>
            阶段{' '}
            <select
              aria-label="查看阶段"
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value)
                setRun('')
                setFile(undefined)
              }}
            >
              {c.phases.length ? (
                c.phases.map((p, i) => (
                  <option key={p.taskId} value={p.taskId}>
                    {i + 1}.{' '}
                    {p.purpose === 'writeup' ? '编写 WP' : '求解 / 复核'} ·{' '}
                    {p.goal.slice(0, 45)}
                  </option>
                ))
              ) : (
                <option value={c.taskId}>准备中</option>
              )}
            </select>
          </label>
          <label>
            执行记录{' '}
            <select
              aria-label="查看执行记录"
              value={run}
              onChange={(e) => setRun(e.target.value)}
            >
              <option value="">最近一次</option>
              {c.phases
                .find((p) => p.taskId === phase)
                ?.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} · {labels[r.state] ?? r.state}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {tab === '概览' && (
          <>
            <h3>任务目标</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.goal}</p>
            {detail?.result && (
              <div className="sp-card">
                <h3>本次执行结果</h3>
                <p>
                  {detail.result.stop_reason === 'flag-found'
                    ? '发现 flag，已结束本轮'
                    : detail.result.summary.split('\n')[0]}
                </p>
                {detail.result.candidates.map((f, i) => (
                  <div key={i}>
                    <Badge
                      state={f.status === 'rejected' ? 'rejected' : 'candidate'}
                      label={candidateLabel(f)}
                    />
                    <pre>{f.description}</pre>
                  </div>
                ))}
                {detail.result.confirmed.map((f) => (
                  <div key={f.id}>
                    <strong>
                      {f.kind === 'flag'
                        ? 'flag 已独立复核'
                        : f.description.includes('WP.md')
                          ? 'WP 已生成并独立读取'
                          : '结果已独立复核'}
                    </strong>
                    <p>{f.title}</p>
                    {f.kind === 'flag' ? (
                      <pre>{f.description}</pre>
                    ) : (
                      <details>
                        <summary>查看结果摘要</summary>
                        <pre>{f.description}</pre>
                      </details>
                    )}
                  </div>
                ))}
                <small>
                  运行结束、目标完成和文件验证分别记录；历史结果保留当次证据状态。
                </small>
              </div>
            )}
            {!active(c) &&
              current?.outcomes
                .filter(
                  (o) =>
                    o.candidate &&
                    o.state !== 'confirmed' &&
                    o.verification?.verified !== true,
                )
                .map((o) => (
                  <div className="sp-card" key={o.intent_id}>
                    <strong>{o.candidate!.title}</strong>
                    <p>仅复核这一候选，不启动其他探索路线。</p>
                    <button
                      disabled={pending}
                      onClick={() => {
                        void act({
                          action: 'verify',
                          intent_id: o.intent_id,
                          run_id: current.id,
                        })
                      }}
                    >
                      独立复核
                    </button>
                  </div>
                ))}
            {brief?.state === 'failed' && (
              <p>
                主会话简报未完成。
                <button
                  onClick={() => {
                    void api
                      .retryBrief(brief.jobId)
                      .then(controller.refresh)
                      .catch((e) => setError(e.message))
                  }}
                >
                  重试简报
                </button>
              </p>
            )}
            <h3>{active(c) ? '调整探索方向' : '继续求解或纠错'}</h3>
            <textarea
              aria-label="调整方向或纠错要求"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder="例如：改为检查附件中的配置文件；或说明 flag 错误的依据"
            />
            <button
              disabled={
                pending ||
                !direction.trim() ||
                c.state === 'queued' ||
                c.state === 'cancelling'
              }
              onClick={() => {
                void act(
                  active(c)
                    ? { action: 'steer', goal: direction }
                    : {
                        action: 'continue',
                        purpose: 'solve',
                        goal: `原任务：${c.goal}\n用户要求：${direction}`,
                      },
                )
              }}
            >
              {' '}
              {active(c) ? '提交新方向' : '按要求重新运行'}
            </button>
            <details className="sp-card">
              <summary>技术详情</summary>
              <p>工作区：{c.cwd}</p>
              <p>
                阶段：{phase}；执行：{current?.id ?? '—'}；停止原因：
                {current?.stop_reason ?? '—'}
              </p>
              {detail?.state.warnings?.map((w) => (
                <p key={w}>{w}</p>
              ))}
              {detail?.result?.errors.map((e, i) => (
                <pre key={i}>{e}</pre>
              ))}
            </details>
          </>
        )}
        {tab === '执行记录' && (
          <>
            <h3>运行活动</h3>
            <ol className="sp-timeline">
              {(c.job?.result?.activity ?? []).map((a, i) => (
                <li key={i}>
                  <time>{new Date(a.at).toLocaleString()}</time>
                  {a.stage}
                </li>
              ))}
            </ol>
            {detail?.state.runs.map((r) => (
              <details className="sp-card" key={r.id} open>
                <summary>
                  {r.id} · {labels[r.state] ?? r.state} · {r.outcomes.length}{' '}
                  条路线
                </summary>
                {r.outcomes.map((o) => (
                  <div key={o.intent_id}>
                    <p>
                      {o.candidate?.title ?? o.intent_id} · {o.state}
                    </p>
                    {o.error && (
                      <details>
                        <summary>原始错误</summary>
                        <pre>{o.error}</pre>
                      </details>
                    )}
                  </div>
                ))}
                <details>
                  <summary>预算与子会话</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        steps: r.steps,
                        explored: r.explored,
                        children: r.children,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </details>
            ))}
          </>
        )}
        {tab === '证据' && (
          <>
            {!detail?.evidence.length && (
              <p className="sp-muted">本次执行尚无工具证据。</p>
            )}
            {detail?.evidence.map((e, i) => (
              <details className="sp-card" key={i}>
                <summary>
                  {e.role === 'verify' ? '独立复核' : '探索'} · {e.tool} ·{' '}
                  {e.intentId}
                </summary>
                <p>独立会话：{e.sessionId}</p>
                <pre>{e.excerpt}</pre>
                {e.sha256 && <small>SHA256：{e.sha256}</small>}
              </details>
            ))}
          </>
        )}
        {tab === '事实图' && (
          <GraphPreview
            inspect={inspect}
            nodes={detail?.state.graph?.nodes ?? []}
            hidden={detail?.hiddenNodes ?? 0}
          />
        )}
        {tab === '文件' && (
          <>
            {!!detail?.attachments?.length && <section className="sp-card"><h3>题目附件</h3><ul className="sp-attachments">{detail.attachments.map((f) => <li key={f.id}><strong>{f.name}</strong> · {f.bytes.toLocaleString()} 字节<p>{f.path}</p></li>)}</ul></section>}
            <p className="sp-muted">
              预览本题 WP 与 evidence 文件。预览内容不执行脚本。
            </p>
            {detail?.files.map((f) => (
              <div className="sp-card" key={f.name}>
                <button
                  onClick={() => {
                    void openFile(f.name)
                  }}
                >
                  {f.name} ↗
                </button>{' '}
                <small>
                  {f.size} 字节 ·{' '}
                  {f.snapshot ? '本次生成快照' : '当前工作区文件'}
                </small>
              </div>
            ))}
            {file && (
              <div className="sp-card">
                <h3>{file.name}</h3>
                <pre className="sp-file">{file.text}</pre>
                {file.truncated && (
                  <p>文件较大，仅显示前 64,000 字符。完整文件位于本题目录。</p>
                )}
              </div>
            )}
            {!detail?.files.length && <p>尚无 WP 或 evidence 文件。</p>}
          </>
        )}
      </div>
    </>
  )
}
