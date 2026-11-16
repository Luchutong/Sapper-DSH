import type { ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { RESULT_RECORD, type TaskResult } from '../panel/result.js'

import { readResult } from '../panel/result-schema.js'
export function candidateLabel(candidate: TaskResult['candidates'][number]): string {
  if (candidate.status === 'rejected')
    return candidate.kind === 'flag' ? 'flag 复核未通过' : '复核未通过'
  if (candidate.kind === 'flag') return '未验证 flag · 可先提交测试'
  if (candidate.evidence_check) return candidate.evidence_check.mode === 'none' ? '已有工具证据 · 未独立复核' : candidate.evidence_check.passed ? '轻量证据检查通过 · 未独立复核' : '已有工具证据 · 轻量检查待补充'
  if (candidate.kind === 'vuln') return '漏洞候选 · 尚未复核'
  return '候选结果 · 尚未复核'
}
const matchResult = (event: { data: unknown }) => {
  const result = readResult(event.data)
  return result ? { id: result.job_id, role: 'start' as const } : null
}

export const resultDefinition: ConversationNodeDefinitionInput<TaskResult> = {
  kind: 'sapper-result',
  target: 'chat',
  match: { [RESULT_RECORD]: matchResult, 'sapper/result': matchResult },
  start: (_context, match) => match.event.data as TaskResult,
  update: (_context, match) => match.event.data as TaskResult,
  buildViewNode: (context) =>
    context.state
      ? {
          key: context.key,
          kind: 'sapper-result',
          id: context.id,
          target: 'chat',
          anchorSeq: context.matches.at(-1)?.event.seq ?? 0,
          location: { kind: 'session' },
          visibility: 'visible',
          data: context.state,
        }
      : null,
}
export function ResultBody({
  result,
  open,
}: {
  result: TaskResult
  open?: (() => void) | undefined
}) {
  return (
    <article
      aria-label="Sapper 任务结果"
      style={{
        border: '1px solid #71809655',
        borderRadius: 12,
        padding: 16,
        margin: '12px 0',
        overflowWrap: 'anywhere',
      }}
    >
      <h3 style={{ marginTop: 0 }}>
        {result.phase === 'flag-found' ? '发现 flag' : result.phase && result.phase !== 'result'
          ? 'Sapper 任务进度'
          : 'Sapper 任务结果'}
      </h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>
        {result.summary.split('\n')[0]?.slice(0, 300)}
      </p>
      {!!result.attachments?.length && <details><summary>题目附件 · {result.attachments.length} 个已保存</summary><ul>{result.attachments.map((f) => <li key={f.id}>{f.name} · {f.bytes.toLocaleString()} 字节<br />{f.path}</li>)}</ul></details>}
      {result.flag_progress && <p>flag 收集：{result.flag_progress.found}{result.flag_progress.target ? ` / ${result.flag_progress.target}` : ''} 个不同值；已独立复核 {result.flag_progress.confirmed} 个</p>}
      {result.verification_mode && result.verification_mode !== 'independent' && <p>快速策略：未独立复核的观察与 confirmed 结果分别显示。</p>}
      {result.confirmed.map((f) => (
        <div
          key={f.id}
          style={{
            borderLeft: '3px solid #32a87d',
            paddingLeft: 12,
            margin: '12px 0',
          }}
        >
          <strong>已独立复核 · {f.title}</strong>
          {f.kind === 'flag' ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
              {f.description}
            </pre>
          ) : (
            <details>
              <summary>
                {f.description.includes('WP.md')
                  ? 'WP 已生成，打开详情查看文件'
                  : '查看结果摘要'}
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap' }}>
                {f.description.slice(0, 1200)}
              </pre>
            </details>
          )}
        </div>
      ))}
      {result.candidates.map((c, i) => (
        <div
          key={i}
          style={{
            borderLeft: '3px solid #d89b35',
            paddingLeft: 12,
            margin: '12px 0',
          }}
        >
          <strong>
            {candidateLabel(c)} ·{' '}
            {c.title}
          </strong>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
            {c.description}
          </pre>
          {c.evidence_check && <details><summary>工具证据检查</summary><p>{c.evidence_check.checks.join('；')}</p>{c.evidence_check.issues.map((issue) => <p key={issue}>{issue}</p>)}</details>}
        </div>
      ))}
      {!!result.errors.length && (
        <details>
          <summary>未完成原因</summary>
          {result.errors.map((e, i) => (
            <p key={i}>{e}</p>
          ))}
        </details>
      )}
      {!!result.activity?.length && (
        <details>
          <summary>任务活动记录</summary>
          <ol>
            {result.activity.map((a, i) => (
              <li key={i}>{a.stage}</li>
            ))}
          </ol>
        </details>
      )}
      <p style={{ fontSize: 12 }}>
        主会话可用 /sapper steer &lt;方向&gt; 调整运行；结束后用 /sapper wp
        编写报告，或 /sapper retry &lt;纠错要求&gt; 重新取证。
      </p>
      {open && <button onClick={open}>打开比赛工作台 ↗</button>}
      <details>
        <summary>执行信息</summary>
        <small>
          {result.run_id ?? '启动阶段'} · 可在 Sapper 任务窗口查看证据和继续执行
        </small>
      </details>
    </article>
  )
}
export function ResultNode({
  node,
  open,
}: Pick<ChatNodeViewProps<'sapper-result'>, 'node'> & {
  open?: (() => void) | undefined
}) {
  return <ResultBody result={node.data} open={open} />
}
