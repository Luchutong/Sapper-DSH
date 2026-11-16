import { useEffect, useState } from 'react'
import type { FlagPolicy } from '../orchestration/flag-policy.js'
import type { VerificationMode } from '../orchestration/verification-policy.js'

export const verificationLabels: Record<VerificationMode, string> = { none: '关闭自动复核（保留工具证据）', lightweight: '轻量证据检查（推荐，不启动第二个代理）', selective: '仅所选重要结论独立复核', independent: '所有结论独立复核（原模式）' }
export function PolicyFields({ policy, verification, disabled, setPolicy, setVerification }: {
  policy: FlagPolicy; verification: VerificationMode; disabled?: boolean
  setPolicy(value: FlagPolicy): void; setVerification(value: VerificationMode): void
}) {
  return <fieldset disabled={disabled} style={{ border: '1px solid #71809655', borderRadius: 8, margin: '16px 0', padding: 12, minWidth: 0 }}>
    <legend>完成与复核策略</legend>
    <label>flag 完成策略{' '}<select aria-label="flag 完成策略" value={policy.mode} onChange={(e) => setPolicy({ ...policy, mode: e.target.value as FlagPolicy['mode'] })}>
      <option value="first">首个 flag 即停</option><option value="count">收集指定数量</option><option value="all">持续收集多个 flag</option>
    </select></label>
    {policy.mode === 'count' && <label style={{ display: 'block', marginTop: 8 }}>目标 flag 数量{' '}<input aria-label="目标 flag 数量" type="number" min={1} max={10000} value={policy.count} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 10000) setPolicy({ ...policy, count: n }) }} /></label>}
    <p>每个新 flag 都立即回传，按不同值计数；达到数量后先收尾，不等待复核。持续收集仍受预算、时限、可用路线和手动停止约束。</p>
    <label>自动复核{' '}<select aria-label="自动复核" value={verification} style={{ maxWidth: '100%' }} onChange={(e) => setVerification(e.target.value as VerificationMode)}>
      {Object.entries(verificationLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>
    <p>轻量检查使用探索代理已有回执；重要结论可补一次针对性工具检查。未经独立复核的观察不会标成 confirmed，仍可事后手动复核。</p>
  </fieldset>
}
export function ResumePolicies({ policy, verification, pending, apply }: { policy: FlagPolicy; verification: VerificationMode; pending: boolean; apply(p: FlagPolicy, v: VerificationMode): void }) {
  const [p, setPolicy] = useState(policy), [v, setVerification] = useState(verification)
  useEffect(() => setPolicy(policy), [policy.mode, policy.count])
  useEffect(() => setVerification(verification), [verification])
  return <details><summary>调整完成/复核策略并继续</summary><PolicyFields policy={p} verification={v} disabled={pending} setPolicy={setPolicy} setVerification={setVerification} />
    <button disabled={pending} onClick={() => apply(p, v)}>按此策略继续</button><p>沿用当前阶段已有发现；已完成的阶段会创建关联后续阶段。历史运行与证据保留。</p>
  </details>
}
