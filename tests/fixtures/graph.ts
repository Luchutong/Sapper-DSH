import type { Fact, GraphSnapshot, Intent } from '../../src/store/types.js'

export const stamp = '2026-11-03T00:00:00Z'
export function fact(id: string, description: string, title?: string): Fact {
  return { id, description, ...(title ? { title } : {}), created_at: stamp, creator: 'fixture', source_intent: null, kind: 'note', doc: null }
}
export function intent(id: string, patch: Partial<Intent> = {}): Intent {
  return { id, from: ['f001'], to: null, title: null, description: `Task ${id}`, status: 'open', worker: null,
    requires_confirmation: false, confirmed_at: null, concluded_at: null, created_at: stamp, creator: 'fixture', ...patch }
}
export function graphFixture(): GraphSnapshot {
  return { project: { id: 'proj', origin: 'test', goal: '验证上下文与复用', status: 'active', created_at: stamp,
    counters: { fact: 3, intent: 0, hint: 0, run: 0 } },
    facts: [fact('goal', '验证上下文与复用'),
      { ...fact('f001', 'Tomcat service observed on localhost port 8080', 'Tomcat 服务发现'), kind: 'service', doc: 'DOC-ONLY-SECRET-EVIDENCE' },
      fact('f002', '已尝试联合查询并记录响应，避免重复测试', 'SQL 注入排查记录'),
      fact('f003', '这里是较早的笔记内容', '历史调试')],
    intents: [], hints: [], warnings: [], integrity: [] }
}
