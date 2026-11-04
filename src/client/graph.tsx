import { useId, useState } from 'react'
import type { PanelState } from '../panel/rpc.js'
type Node = NonNullable<NonNullable<PanelState['graph']>['nodes']>[number]
const labels: Record<string, string> = { confirmed: '已验证', observed: '观察', open: '待推进', claimed: '执行中', done: '已结案', complete: '已完成' }
export function GraphPreview({ nodes = [] }: { nodes?: Node[] }) {
  const arrow = 'sapper-arrow-' + useId().replaceAll(':', ''), [selected, setSelected] = useState<Node>()
  if (!nodes.length) return <p>发起任务后，事实与意图的关系会显示在这里。</p>
  const columns = [nodes.filter(n => n.type === 'fact' && !n.source_intent), nodes.filter(n => n.type === 'intent'), nodes.filter(n => n.type === 'fact' && n.source_intent)]
  const positions = new Map(columns.flatMap((col, x) => col.map((n, y) => [n.id, { x: 24 + x * 340, y: 50 + y * 90 }] as const)))
  const edges = nodes.filter(n => n.type === 'intent').flatMap(n => [...(n.from ?? []).map(from => [from, n.id]), ...(n.to ? [[n.id, n.to]] : [])])
  return <section aria-label="任务事实图">
    <p>输入事实 → 可执行意图 → 复核后的结果；点击节点查看状态。</p>
    <div style={{ overflow: 'auto', border: '1px solid #71809655', borderRadius: 10, maxHeight: 420 }}>
      <svg role="img" aria-label="事实与意图关系图" width="1040" height={Math.max(180, ...columns.map(c => c.length * 90 + 60))}>
        <defs><marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="#7890aa" /></marker></defs>
        {['输入事实', '执行意图', '结果事实'].map((name, i) => <text key={name} x={24 + i * 340} y={25} fill="currentColor" fontSize={14}>{name}</text>)}
        {edges.map(([from, to], i) => { const a = positions.get(from!), b = positions.get(to!); return a && b ? <path key={i} d={`M${a.x + 285},${a.y + 29} C${a.x + 315},${a.y + 29} ${b.x - 30},${b.y + 29} ${b.x},${b.y + 29}`} stroke="#7890aa" fill="none" markerEnd={`url(#${arrow})`} /> : null })}
        {nodes.map(n => { const p = positions.get(n.id)!; const color = n.status === 'confirmed' || n.status === 'done' ? '#259c77' : n.status === 'claimed' ? '#518ed8' : '#8895a7'; return <g key={n.id} role="button" tabIndex={0} aria-label={`${n.id} ${n.title}`} onClick={() => setSelected(n)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelected(n) }} style={{ cursor: 'pointer' }}>
          <title>{n.title}</title><rect x={p.x} y={p.y} width={285} height={60} rx={9} fill="var(--dsw-alias-bg-base, #fff)" stroke={color} strokeWidth={2} />
          <text x={p.x + 12} y={p.y + 22} fill="currentColor" fontSize={13}>{n.id} · {n.title.slice(0, 20)}</text><text x={p.x + 12} y={p.y + 45} fill={color} fontSize={12}>{labels[n.status] ?? n.status}</text>
        </g> })}
      </svg>
    </div>
    {selected && <p role="status"><strong>{selected.id} · {selected.title}</strong><br />状态：{labels[selected.status] ?? selected.status}；依赖：{selected.from?.join(', ') || '无'}；结果：{selected.to ?? '待生成'}</p>}
  </section>
}
