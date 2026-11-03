import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeBase } from '../src/kb/index.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sapper KB 中文 ')); roots.push(cwd); return cwd
}
const customEntry = { id: 'kb001', title: '自定义安全笔记', description: '本地测试覆盖', detail: 'DETAIL-ONLY-FIXTURE', tags: ['local'], commands: ['echo not-executed'], source: 'test' }

describe('M2 offline knowledge', () => {
  it('loads 56 bundled entries and searches Chinese, English and tags without expanding details', async () => {
    const kb = new KnowledgeBase()
    const data = await kb.read()
    expect(data.entries).toHaveLength(56)
    expect(data.warnings).toEqual([])
    expect(kb.search(data, 'Web 信息收集')[0]?.id).toBe('kb001')
    expect(kb.search(data, 'SQL 注入').length).toBeGreaterThan(0)
    expect(kb.search(data, 'web', 5, 'recon').some(e => e.id === 'kb001')).toBe(true)
    expect(kb.search(data, '')).toEqual([])
    expect(kb.search(data, 'web')[0]).not.toHaveProperty('detail')
    expect(kb.search(data, 'web')[0]).not.toHaveProperty('commands')
    expect(kb.get(data, 'kb001').commands.length).toBeGreaterThan(0)
    expect(() => kb.get(data, '../../package')).toThrow('KB id')
    expect(() => kb.search(data, 'web', 0)).toThrow('limit')
    expect(() => kb.get(data, 'kb9999')).toThrow('不存在')
    data.entries[0]!.title = 'mutated caller copy'
    expect((await kb.read()).entries[0]!.title).not.toBe('mutated caller copy')
  })
  it('overlays workspace custom entries, reloads edits, and contains malformed records', async () => {
    const cwd = await workspace(), dir = path.join(cwd, 'kb-custom')
    await mkdir(dir)
    await writeFile(path.join(dir, 'kb001.json'), JSON.stringify(customEntry))
    await writeFile(path.join(dir, 'kb999.json'), '{bad')
    await writeFile(path.join(dir, 'kb998.json'), JSON.stringify({ ...customEntry, id: 'wrong' }))
    const kb = new KnowledgeBase()
    const data = await kb.read(cwd, 'kb-custom')
    expect(kb.get(data, 'kb001')).toMatchObject({ title: customEntry.title, detail: 'DETAIL-ONLY-FIXTURE' })
    expect(data.entries).toHaveLength(56)
    expect(data.warnings).toHaveLength(2)
    await writeFile(path.join(dir, 'kb001.json'), JSON.stringify({ ...customEntry, title: '更新后的条目' }))
    expect(kb.get(await kb.read(cwd, 'kb-custom'), 'kb001').title).toBe('更新后的条目')
    expect((await readdir(cwd)).sort()).toEqual(['kb-custom'])
  })
  it('does not create a missing custom directory and rejects escapes or junctions', async () => {
    const cwd = await workspace(), kb = new KnowledgeBase()
    expect((await kb.read(cwd, 'absent-kb')).entries).toHaveLength(56)
    expect(await readdir(cwd)).toEqual([])
    await expect(kb.read(cwd, '../escape')).rejects.toThrow('边界')
    await expect(kb.read(cwd, '.')).rejects.toThrow('独立子目录')
    const outside = await workspace()
    await symlink(outside, path.join(cwd, 'linked-kb'), 'junction')
    await expect(kb.read(cwd, 'linked-kb')).rejects.toThrow('符号链接')
    expect(await readdir(outside)).toEqual([])
  })
})
