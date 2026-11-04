import { act, create } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Workbench } from '../src/client/workbench.js'
import { ResultBody } from '../src/client/result.js'
import type { WorkbenchController } from '../src/client/workbench-store.js'
import type { BrowserContext } from '../src/dsh-adapter/client.js'
import type { WorkbenchPanelApi, PanelState } from '../src/panel/rpc.js'
import type { TaskResult } from '../src/panel/result.js'
import type { Challenge, WorkbenchSnapshot, TaskDetail } from '../src/workbench/contracts.js'

it.each([
  ['note', 'unverified', '候选结果 · 尚未复核'],
  ['vuln', 'unverified', '漏洞候选 · 尚未复核'],
  ['flag', 'unverified', '未验证 flag · 可先提交测试'],
  ['note', 'rejected', '复核未通过'],
  ['flag', 'rejected', 'flag 复核未通过'],
] as const)('labels %s/%s consistently in the real workbench and chat result, without changing the candidate', async (kind, status, expected) => {
  const candidate = { kind, status, title: 'repeater analysis', description: kind === 'flag' ? 'CTF2{FIXTURE-ONLY-7C42}' : 'ELF64, Canary found, NX enabled, Partial RELRO' },
    result: TaskResult = { job_id: 'job', task_id: 'task', goal: 'Solve repeater', state: 'running', summary: '正在独立复核', candidates: [candidate], confirmed: [], errors: [] },
    state: PanelState = { cwd: '/repeater', active: 'task', tasks: [], runs: [] },
    challenge: Challenge = { id: 'workspace:task', workspaceId: 'workspace', taskId: 'task', sessionId: 'main', cwd: '/repeater', title: 'repeater', goal: result.goal, state: 'running', updatedAt: '2026-11-04T13:56:45Z', createdAt: '2026-11-04T13:54:01Z', unread: false, flags: [], phases: [{ taskId: 'task', purpose: 'solve', goal: result.goal, status: 'active', runs: [] }] },
    data: WorkbenchSnapshot = { preferences: { rootDir: '/contest', parallelism: 2 }, durable: true, available: true, launches: [], challenges: [challenge], jobs: [], briefs: [], defaults: { presets: [], permissions: [] } },
    detail: TaskDetail = { address: { workspaceId: 'workspace', taskId: 'task' }, state, result, evidence: [], files: [], hiddenNodes: 0, totalNodes: 0 },
    taskAction = vi.fn(async () => undefined),
    api: WorkbenchPanelApi = {
      overview: async () => data, preferences: async (input) => input, launch: vi.fn(),
      detail: vi.fn(async () => detail), taskAction, file: vi.fn(), node: vi.fn(), seen: vi.fn(), retryBrief: vi.fn(),
      targets: async () => [], state: async () => state, action: vi.fn(),
    },
    snapshot = { data, selected: challenge.id },
    controller: WorkbenchController = { getSnapshot: () => snapshot, subscribe: () => () => {}, select: vi.fn(), refresh: vi.fn(async () => {}), connect: vi.fn(), open: vi.fn(), reveal: vi.fn(async () => {}) },
    before = structuredClone(candidate)
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<Workbench api={api} controller={controller} ctx={{} as BrowserContext} />) })
    const badges = view.root.findAllByProps({ className: 'sp-badge' }).map((badge) => badge.children.join(''))
    expect(badges).toContain(expected)
    if (kind !== 'flag') expect(badges.some((label) => /flag/i.test(label))).toBe(false)
    const chat = renderToStaticMarkup(<ResultBody result={result} />)
    expect(chat).toContain(expected)
    expect(chat).toContain(candidate.description)
    expect(candidate).toEqual(before)
    expect(taskAction).not.toHaveBeenCalled()
  } finally { await act(async () => { view?.unmount() }) }
})
