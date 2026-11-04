import type { ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TaskResult } from '../panel/result.js'

export const resultDefinition: ConversationNodeDefinitionInput<TaskResult> = {
  kind: 'sapper-result', target: 'chat',
  match: { 'sapper/result': event => ({ id: String((event.data as TaskResult).job_id), role: 'start' }) },
  start: (_context, match) => match.event.data as TaskResult,
  update: (_context, match) => match.event.data as TaskResult,
  buildViewNode: context => context.state ? { key: context.key, kind: 'sapper-result', id: context.id, target: 'chat', anchorSeq: context.matches.at(-1)?.event.seq ?? 0, location: { kind: 'session' }, visibility: 'visible', data: context.state } : null,
}
export function ResultBody({ result }: { result: TaskResult }) {
  return <article aria-label="Sapper 任务结果" style={{ border: '1px solid #71809655', borderRadius: 12, padding: 16, margin: '12px 0', overflowWrap: 'anywhere' }}>
    <h3 style={{ marginTop: 0 }}>Sapper 任务结果</h3>
    <p style={{ whiteSpace: 'pre-wrap' }}>{result.summary}</p>
    {result.confirmed.map(f => <div key={f.id} style={{ borderLeft: '3px solid #32a87d', paddingLeft: 12, margin: '12px 0' }}><strong>已独立复核 · {f.title}</strong><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{f.description}</pre></div>)}
    {result.candidates.map((c, i) => <div key={i} style={{ borderLeft: '3px solid #d89b35', paddingLeft: 12, margin: '12px 0' }}><strong>{c.status === 'rejected' ? '复核未通过' : '候选 · 尚未确认'} · {c.title}</strong><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{c.description}</pre></div>)}
    {!!result.errors.length && <details><summary>未完成原因</summary>{result.errors.map((e, i) => <p key={i}>{e}</p>)}</details>}
    <small>{result.run_id ?? '启动阶段'} · 可在 Sapper 任务窗口查看证据和继续执行</small>
  </article>
}
export function ResultNode({ node }: Pick<ChatNodeViewProps<'sapper-result'>, 'node'>) { return <ResultBody result={node.data} /> }
