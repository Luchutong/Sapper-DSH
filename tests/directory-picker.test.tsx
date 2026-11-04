import { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker as HostPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker'
import { DirectoryPickerController } from '@deepseek-ai/dsh-api-workspace-controller'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { DirectoryPicker } from '../src/client/directory-picker.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
async function mount(capability: DirectoryPickerCapability) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(class extends HostPicker {
    constructor(scoped: Context) { super(scoped) }
    capability() { return capability }
  })
  await ctx.plugin(DirectoryPickerController)
  const controller = ctx.get('directoryPickerController')!
  return {
    openSession() {},
    pickDirectory: vi.fn(() => controller.pick(new AbortController().signal)),
    listDirectory: vi.fn(async (path?: string, signal = new AbortController().signal) => {
      try { return await controller.list(path, signal) }
      catch (error) { throw Object.assign(new Error((error as Error).message), { rpcError: error }) }
    }),
  }
}
function listing(path: string): DirectoryListing {
  return {
    path, home: 'D:\\比赛', crumbs: [{ name: 'D:\\', path: 'D:\\', hidden: false }, { name: '比赛', path: 'D:\\比赛', hidden: false }],
    entries: [{ name: '中文 目录', path: 'D:\\比赛\\中文 目录', hidden: false }, { name: '.隐藏', path: 'D:\\比赛\\.隐藏', hidden: true }], truncated: true,
  }
}
function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').find((b) => b.children.join('') === label)!
}
it.each(['D:\\比赛\\中文 目录', null])('uses the real native capability and preserves cancellation (%s)', async (selected) => {
  const pick = vi.fn(async () => selected),
    workspace = await mount({ kind: 'native', pick }),
    onPicked = vi.fn(), onClose = vi.fn()
  let view!: ReactTestRenderer
  await act(async () => { view = create(<DirectoryPicker workspace={workspace} initialPath="" onPicked={onPicked} onClose={onClose} />) })
  cleanup.push(() => view.unmount())
  expect(workspace.listDirectory).toHaveBeenCalledOnce()
  expect(pick).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
  if (selected) expect(onPicked).toHaveBeenCalledWith(selected)
  else expect(onPicked).not.toHaveBeenCalled()
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})
it('browses opaque host paths, supports hidden directories and selection without calling native pick', async () => {
  const workspace = await mount({ kind: 'browse', list: async (path) => listing(path ?? 'D:\\比赛'), createDirectory: async () => { throw new Error('unused') } }),
    onPicked = vi.fn(), onClose = vi.fn()
  let view!: ReactTestRenderer
  await act(async () => { view = create(<DirectoryPicker workspace={workspace} initialPath="D:\\比赛" onPicked={onPicked} onClose={onClose} />) })
  cleanup.push(() => view.unmount())
  expect(workspace.pickDirectory).not.toHaveBeenCalled()
  expect(button(view, '📁 .隐藏')).toBeUndefined()
  await act(async () => { view.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }) })
  expect(button(view, '📁 .隐藏')).toBeDefined()
  await act(async () => { button(view, '📁 中文 目录').props.onClick() })
  expect(workspace.listDirectory).toHaveBeenLastCalledWith('D:\\比赛\\中文 目录', expect.any(AbortSignal))
  expect(onPicked).not.toHaveBeenCalled()
  await act(async () => { button(view, '使用此目录').props.onClick() })
  expect(onPicked).toHaveBeenCalledExactlyOnceWith('D:\\比赛\\中文 目录')
  expect(onClose).toHaveBeenCalledOnce()
})
it('keeps unreadable paths editable, returns home and cancels pending scans on close', async () => {
  let signal: AbortSignal | undefined
  const workspace = await mount({ kind: 'browse', list: async (path, currentSignal) => {
    signal = currentSignal
    if (path) throw new Error('路径不可读取')
    return listing('D:\\比赛')
  }, createDirectory: async () => { throw new Error('unused') } }), onPicked = vi.fn()
  let view!: ReactTestRenderer
  await act(async () => { view = create(<DirectoryPicker workspace={workspace} initialPath="bad path" onPicked={onPicked} onClose={() => {}} />) })
  expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('路径不可读取')
  expect(button(view, '使用此目录').props.disabled).toBe(true)
  await act(async () => { button(view, '主目录').props.onClick() })
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  expect(button(view, '使用此目录').props.disabled).toBe(false)
  await act(async () => { view.unmount() })
  expect(signal?.aborted).toBe(true)
  expect(onPicked).not.toHaveBeenCalled()
  expect(workspace.pickDirectory).not.toHaveBeenCalled()
})
