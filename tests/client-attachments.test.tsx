import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { Workbench } from '../src/client/workbench.js'
import type { WorkbenchController } from '../src/client/workbench-store.js'
import type { BrowserContext } from '../src/dsh-adapter/client.js'
import type { WorkbenchPanelApi } from '../src/panel/rpc.js'
import type { LaunchRecord, LaunchInput, WorkbenchSnapshot } from '../src/workbench/contracts.js'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'

function harness(options: { fail?: string; block?: boolean; initial?: LaunchRecord } = {}) {
  let record = options.initial, fail = options.fail
  const order: string[] = [], release = vi.fn(() => { order.push('release') }),
    data: WorkbenchSnapshot = { preferences: { rootDir: '/contest', parallelism: 2 }, durable: true, available: true, uploadAvailable: true, launches: record ? [record] : [], challenges: [], jobs: [], briefs: [], defaults: { presets: [], permissions: [] } },
    snapshot = { data }, controller: WorkbenchController = { getSnapshot: () => snapshot, subscribe: () => () => {}, refresh: vi.fn(async () => {}), select: vi.fn(), connect: vi.fn(), open: vi.fn(), reveal: vi.fn(async () => {}) },
    prepare = vi.fn(async (input: LaunchInput) => {
      record ??= { requestId: input.requestId, input, title: 'fixture', cwd: '/contest/task', sessionId: 'main', createdAt: new Date().toISOString(), files: (input.attachments ?? []).map((f, i) => ({ ...f, path: `attachments/${i}-${f.name}` })) }
      return structuredClone(record)
    }),
    launch = vi.fn(async () => ({ ...structuredClone(record!), jobId: 'job' })),
    imported = vi.fn(async (input: { attachmentId: string }) => {
      record!.files!.find((f) => f.id === input.attachmentId)!.sha256 = 'a'.repeat(64)
      return structuredClone(record!)
    }),
    api: WorkbenchPanelApi = { overview: async () => data, preferences: async (p) => p, prepare, launch, importAttachment: imported, detail: vi.fn(), taskAction: vi.fn(), file: vi.fn(), node: vi.fn(), seen: vi.fn(), retryBrief: vi.fn(), targets: vi.fn(), state: vi.fn(), action: vi.fn() },
    upload = vi.fn<NonNullable<BrowserContext['fileUpload']>['upload']>(async (_sessionId, body, name, signal, progress) => {
      order.push('upload:' + name)
      progress?.({ loaded: 1, total: (body as File).size })
      if (options.block) await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
      if (fail === name) { fail = undefined; throw new Error('fixture network failure') }
      return { ok: true, value: { receiptId: crypto.randomUUID(), file: { attachmentId: 'fixture', name: name!, bytes: (body as File).size } } as FileUploadValue }
    }),
    openSession = vi.fn(() => { order.push('open') }),
    ctx = { fileUpload: { upload }, sessions: { retain: () => ({ ready: Promise.resolve(), release }) }, uiWorkspace: { openSession, pickDirectory: vi.fn() } } as unknown as BrowserContext
  return { controller, api, ctx, upload, launch, prepare, imported, release, openSession, order }
}
const button = (view: ReturnType<typeof create>, name: string) => view.root.findAllByType('button').find((b) => b.children.join('') === name)!
async function newForm(h: ReturnType<typeof harness>) {
  let view!: ReturnType<typeof create>
  await act(async () => { view = create(<Workbench api={h.api} controller={h.controller} ctx={h.ctx} />) })
  await act(async () => { button(view, '＋ 新建题目').props.onClick() })
  await act(async () => { view.root.findByProps({ 'aria-label': '任务目标' }).props.onChange({ target: { value: '分析附件' } }) })
  return view
}
async function choose(view: ReturnType<typeof create>, label: string, files: File[]) {
  await act(async () => { view.root.findByProps({ 'aria-label': label }).props.onChange({ currentTarget: { files, value: '' } }) })
}
it('adds/removes files and retries only the failed upload before opening the main session', async () => {
  const h = harness({ fail: 'b.bin' }), view = await newForm(h), a = new File(['a'], '中文.zip'), b = new File(['b'], 'b.bin')
  try {
    await choose(view, '添加题目附件', [a, b])
    await act(async () => { button(view, '移除 b.bin').props.onClick() })
    await choose(view, '添加题目附件', [b])
    await act(async () => { button(view, '创建并开始').props.onClick() })
    expect(h.launch).not.toHaveBeenCalled()
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('fixture network failure')
    const id = h.prepare.mock.calls[0]![0].requestId
    await act(async () => { button(view, '继续创建').props.onClick() })
    expect(h.prepare.mock.calls[1]![0].requestId).toBe(id)
    expect(h.upload.mock.calls.map((c) => c[2])).toEqual(['中文.zip', 'b.bin', 'b.bin'])
    expect(h.imported).toHaveBeenCalledTimes(2)
    expect(h.launch).toHaveBeenCalledOnce()
    expect(h.openSession).toHaveBeenCalledExactlyOnceWith('main')
    expect(h.order.indexOf('open')).toBeLessThan(h.order.lastIndexOf('release'))
  } finally { await act(async () => { view.unmount() }) }
})
it('cancels an active upload without admitting a task and releases its session reference', async () => {
  const h = harness({ block: true }), view = await newForm(h)
  try {
    await choose(view, '添加题目附件', [new File(['data'], 'sample.bin')])
    await act(async () => { button(view, '创建并开始').props.onClick() })
    expect(h.upload).toHaveBeenCalledOnce()
    await act(async () => { button(view, '取消上传').props.onClick() })
    expect(h.upload.mock.calls[0]![3]?.aborted).toBe(true)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.openSession).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledOnce()
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('已取消')
    expect(button(view, '继续创建').props.disabled).toBe(false)
  } finally { await act(async () => { view.unmount() }) }
})
it('resumes a durable draft by reselecting only the unfinished original file', async () => {
  const files = [new File(['a'], 'a.bin'), new File(['b'], 'b.bin')],
    input: LaunchInput = { requestId: crypto.randomUUID(), title: '恢复题目', rootDir: '/contest', goal: '分析附件', attachments: files.map((f) => ({ id: crypto.randomUUID(), name: f.name, bytes: f.size })) },
    initial: LaunchRecord = { requestId: input.requestId, input, title: input.title, cwd: '/contest/task', sessionId: 'main', createdAt: new Date().toISOString(), files: input.attachments!.map((f, i) => ({ ...f, path: `attachments/${i}.bin`, ...(i === 0 ? { sha256: 'a'.repeat(64) } : {}) })) },
    h = harness({ initial })
  let view!: ReturnType<typeof create>
  try {
    await act(async () => { view = create(<Workbench api={h.api} controller={h.controller} ctx={h.ctx} />) })
    const row = view.root.findAllByType('button').find((b) => b.findAllByType('strong').some((s) => s.children.join('') === initial.title))!
    await act(async () => { row.props.onClick() })
    await choose(view, '重新选择 b.bin', [files[1]!])
    await act(async () => { button(view, '继续创建').props.onClick() })
    expect(h.upload.mock.calls.map((c) => c[2])).toEqual(['b.bin'])
    expect(h.prepare.mock.calls[0]![0].requestId).toBe(initial.requestId)
    expect(h.launch).toHaveBeenCalledOnce()
  } finally { await act(async () => { view?.unmount() }) }
})
