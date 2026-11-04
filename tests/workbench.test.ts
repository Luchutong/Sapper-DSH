import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { WorkbenchStore } from '../src/workbench/store.js'
import { directoryName } from '../src/workbench/native.js'
import { graphLayout } from '../src/client/graph.js'
describe('durable workbench recovery', () => {
  it('restores FIFO queued work, marks in-flight work interrupted and never replays completed results or briefs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sapper durable 中文 '))
    const mount = async () => {
      const ctx = new Context()
      await ctx.plugin(Storage)
      await ctx.plugin(Json, { root })
      await ctx.plugin(Domain, { backend: 'json' })
      let ready!: () => void
      const loaded = new Promise<void>((r) => {
        ready = r
      })
      const store = new WorkbenchStore(ctx, ready)
      await loaded
      return { ctx, store }
    }
    try {
      const first = await mount()
      await first.store.change((d) => {
        d.preferences = { rootDir: root, parallelism: 3 }
        for (const [id, state] of [
          ['a', 'running'],
          ['b', 'queued'],
          ['c', 'completed'],
        ] as const)
          d.jobs[id] = {
            id,
            sessionId: id,
            cwd: root,
            input: { action: 'run' },
            goal: id,
            state,
            createdAt: id,
          }
        d.briefs.c = {
          jobId: 'c',
          sessionId: 'c',
          messageId: 'm',
          state: 'completed',
        }
        d.briefs.a = {
          jobId: 'a',
          sessionId: 'a',
          messageId: 'n',
          state: 'running',
        }
      })
      await first.ctx.fiber.dispose()
      const second = await mount()
      try {
        const data = second.store.snapshot()
        expect(data.preferences.parallelism).toBe(3)
        expect(Object.values(data.jobs).map((j) => j.state)).toEqual([
          'interrupted',
          'queued',
          'completed',
        ])
        expect(data.briefs.c?.state).toBe('completed')
        expect(data.briefs.a?.state).toBe('failed')
        await second.store.change((d) => {
          d.preferences.parallelism = 1
        })
        expect(second.store.snapshot().jobs.b?.state).toBe('queued')
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each([
    'CON',
    'NUL.txt',
    'COM1',
    '../中文:题目?',
    '同名题目',
    '长中文标题'.repeat(20),
  ])(
    'uses safe distinct Windows-compatible child directory names for %s',
    (title) => {
      const a = directoryName(
          title,
          'abcd1234-1',
          new Date('2026-11-04T00:00:00Z'),
        ),
        b = directoryName(title, 'abcd1235-2', new Date('2026-11-04T00:00:00Z'))
      expect(a).not.toMatch(/[<>:"/\\|?*\x00-\x1f]/)
      expect(a).not.toMatch(/^(con|nul|prn|aux|com\d|lpt\d)(\.|$)/i)
      expect(a.length).toBeLessThan(100)
      expect(a).not.toBe(b)
    },
  )
  it('ranks dependencies across multiple rounds and keeps cyclic nodes visible', () => {
    const nodes = [
      { id: 'f1', type: 'fact' as const, title: '输入', status: 'observed' },
      {
        id: 'i1',
        type: 'intent' as const,
        title: '探索',
        status: 'done',
        from: ['f1'],
        to: 'f2',
      },
      {
        id: 'f2',
        type: 'fact' as const,
        title: '结果',
        status: 'confirmed',
        source_intent: 'i1',
      },
      {
        id: 'i2',
        type: 'intent' as const,
        title: '再探索',
        status: 'open',
        from: ['f2'],
      },
      {
        id: 'cycle',
        type: 'intent' as const,
        title: '循环',
        status: 'open',
        from: ['cycle'],
      },
    ]
    const { positions } = graphLayout(nodes)
    expect(positions.size).toBe(5)
    expect(positions.get('i2')!.x).toBeGreaterThan(positions.get('f2')!.x)
    expect(positions.get('f2')!.x).toBeGreaterThan(positions.get('i1')!.x)
  })
})
