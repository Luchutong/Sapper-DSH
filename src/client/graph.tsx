import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PanelState } from '../panel/rpc.js'
type Node = NonNullable<NonNullable<PanelState['graph']>['nodes']>[number]
const labels: Record<string, string> = {
  confirmed: '已独立复核',
  observed: '已观察',
  open: '待推进',
  claimed: '执行中',
  done: '已结案',
  stopped: '已停止',
  complete: '已完成',
}
/** Longest-path ranks for the acyclic part; cyclic/dependent remainder stays visible. */
export function graphLayout(nodes: Node[]) {
  const ids = new Set(nodes.map((n) => n.id)),
    edges = nodes
      .filter((n) => n.type === 'intent')
      .flatMap((n) => [
        ...(n.from ?? []).map((f) => [f, n.id] as const),
        ...(n.to ? [[n.id, n.to] as const] : []),
      ])
      .filter(([a, b]) => ids.has(a) && ids.has(b))
  for (const n of nodes)
    if (
      n.source_intent &&
      ids.has(n.source_intent) &&
      !edges.some(([a, b]) => a === n.source_intent && b === n.id)
    )
      edges.push([n.source_intent, n.id])
  const ranks = new Map<string, number>(),
    degree = new Map(
      nodes.map((n) => [n.id, edges.filter(([, b]) => b === n.id).length]),
    ),
    queue = nodes.filter((n) => degree.get(n.id) === 0).map((n) => n.id)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    ranks.set(id, ranks.get(id) ?? 0)
    for (const [, b] of edges.filter(([a]) => a === id)) {
      ranks.set(b, Math.max(ranks.get(b) ?? 0, ranks.get(id)! + 1))
      degree.set(b, degree.get(b)! - 1)
      if (degree.get(b) === 0) queue.push(b)
    }
  }
  for (const n of nodes)
    if (!queue.includes(n.id))
      ranks.set(
        n.id,
        Math.min(ranks.get(n.id) ?? 0, Math.max(1, nodes.length - 1)),
      )
  const counts = new Map<number, number>(),
    positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const rank = ranks.get(n.id) ?? 0,
      y = counts.get(rank) ?? 0
    positions.set(n.id, { x: 24 + rank * 300, y: 24 + y * 112 })
    counts.set(rank, y + 1)
  }
  return {
    positions,
    edges,
    width: Math.max(340, ...[...positions.values()].map((p) => p.x + 284)),
    height: Math.max(200, ...[...positions.values()].map((p) => p.y + 108)),
  }
}
export function GraphPreview({
  nodes = [],
  hidden = 0,
  inspect,
}: {
  nodes?: Node[]
  hidden?: number
  inspect?:
    | ((
        id: string,
      ) => Promise<{ title?: string; description: string; doc?: string }>)
    | undefined
}) {
  const arrow = 'sapper-arrow-' + useId().replaceAll(':', ''),
    [selected, setSelected] = useState<Node>(),
    [info, setInfo] = useState<{
      title?: string
      description: string
      doc?: string
    }>(),
    [error, setError] = useState(''),
    [view, setView] = useState({ x: 0, y: 0, scale: 1 }),
    windowRef = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number; vx: number; vy: number }>(),
    layout = useMemo(() => graphLayout(nodes), [nodes])
  const fit = () => {
    const rect = windowRef.current?.getBoundingClientRect()
    if (!rect) return
    const scale = Math.min(
      1,
      rect.width / layout.width,
      rect.height / layout.height,
    )
    setView({ x: 10, y: 10, scale: Math.max(0.005, scale * 0.94) })
  }
  useEffect(() => {
    fit()
  }, [layout.width, layout.height, nodes.length])
  useEffect(() => {
    let live = true
    setInfo(undefined)
    setError('')
    if (selected && inspect)
      void inspect(selected.id)
        .then((value) => {
          if (live) setInfo(value)
        })
        .catch((e) => {
          if (live) setError(e.message)
        })
    return () => {
      live = false
    }
  }, [selected?.id, inspect])
  const zoom = (factor: number) =>
    setView((v) => {
      const scale = Math.max(0.005, Math.min(3, v.scale * factor))
      const r = windowRef.current?.getBoundingClientRect(),
        x = (r?.width ?? 600) / 2,
        y = (r?.height ?? 380) / 2
      return {
        x: x - ((x - v.x) * scale) / v.scale,
        y: y - ((y - v.y) * scale) / v.scale,
        scale,
      }
    })
  if (!nodes.length) return <p>发起任务后，事实与意图的关系会显示在这里。</p>
  return (
    <section aria-label="任务事实图">
      <div className="sp-graph-tools">
        <button onClick={fit}>适应视口</button>
        <button aria-label="图放大" onClick={() => zoom(1.2)}>
          ＋
        </button>
        <button aria-label="图缩小" onClick={() => zoom(1 / 1.2)}>
          −
        </button>
        <button
          onClick={() => {
            setView({ x: 0, y: 0, scale: 1 })
            setSelected(undefined)
          }}
        >
          重置
        </button>
        <small>
          {Math.round(view.scale * 100)}% · {nodes.length} 个节点 · 拖动平移
        </small>
      </div>
      {hidden > 0 && (
        <p role="status">
          另有 {hidden} 个节点未纳入本视图；完整数据保留在本题事实图文件中。
        </p>
      )}
      <div
        ref={windowRef}
        className="sp-graph-window"
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12)
          }
        }}
      >
        <svg
          role="img"
          aria-label="事实与意图关系图"
          onPointerDown={(e) => {
            if ((e.target as Element).closest('[data-node]')) return
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              vx: view.x,
              vy: view.y,
            }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (d)
              setView((v) => ({
                ...v,
                x: d.vx + e.clientX - d.x,
                y: d.vy + e.clientY - d.y,
              }))
          }}
          onPointerUp={() => {
            drag.current = undefined
          }}
        >
          <defs>
            <marker
              id={arrow}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 Z" fill="#8090aa" />
            </marker>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
            {layout.edges.map(([from, to], i) => {
              const a = layout.positions.get(from)!,
                b = layout.positions.get(to)!
              return (
                <path
                  key={i}
                  d={`M${a.x + 260},${a.y + 40} C${a.x + 284},${a.y + 40} ${b.x - 24},${b.y + 40} ${b.x},${b.y + 40}`}
                  stroke="#8090aa"
                  fill="none"
                  markerEnd={`url(#${arrow})`}
                />
              )
            })}
            {nodes.map((n) => {
              const p = layout.positions.get(n.id)!,
                color = ['confirmed', 'done'].includes(n.status)
                  ? '#259c77'
                  : n.status === 'claimed'
                    ? '#647ce8'
                    : '#8895a7',
                lines = Array.from(
                  n.title.matchAll(/.{1,18}/gu),
                  (m) => m[0],
                ).slice(0, 2)
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.id} ${n.title}`}
                  onClick={() => setSelected(n)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelected(n)
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <title>{n.title}</title>
                  <rect
                    x={p.x}
                    y={p.y}
                    width={260}
                    height={88}
                    rx={9}
                    fill="var(--sp-bg,var(--dsw-alias-bg-base,#fff))"
                    stroke={selected?.id === n.id ? '#647ce8' : color}
                    strokeWidth={selected?.id === n.id ? 3 : 1.6}
                  />
                  <text x={p.x + 12} y={p.y + 20} fontSize={11} fill={color}>
                    {n.id} · {labels[n.status] ?? n.status}
                  </text>
                  {lines.map((line, i) => (
                    <text
                      key={i}
                      x={p.x + 12}
                      y={p.y + 43 + i * 20}
                      fontSize={13}
                      fill="currentColor"
                    >
                      {line}
                      {i === 1 && n.title.length > 36 ? '…' : ''}
                    </text>
                  ))}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
      {selected && (
        <div className="sp-card" role="status">
          <strong>
            {selected.id} · {info?.title ?? selected.title}
          </strong>
          {info && <p style={{ whiteSpace: 'pre-wrap' }}>{info.description}</p>}
          {info?.doc && (
            <details>
              <summary>完整文档</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {info.doc}
              </pre>
            </details>
          )}
          {error && <p role="alert">{error}</p>}
          <p>状态：{labels[selected.status] ?? selected.status}</p>
          <p>
            依赖：{selected.from?.join(', ') || selected.source_intent || '无'}
            ；结果：{selected.to ?? '—'}
          </p>
        </div>
      )}
    </section>
  )
}
