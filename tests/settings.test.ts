import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/settings.js'
import { resolveStorePath } from '../src/store/paths.js'
import path from 'node:path'
import { matchesTool } from '../src/orchestration/tool-policy.js'

describe('settings and workspace boundary', () => {
  it('supports exact and MCP-only prefix selectors while retaining explicit empty scopes', () => {
    expect(resolveConfig().orchestration.exploreTools).toContain('mcp__*')
    expect(resolveConfig({ orchestration: { exploreTools: [] } }).orchestration.exploreTools).toEqual([])
    expect(matchesTool(['mcp__ida__*'], 'mcp__ida__decompile')).toBe(true)
    expect(matchesTool(['mcp__ida__*'], 'mcp__browser__read')).toBe(false)
    for (const tool of ['*', 'read*', 'sapper_fact', 'subagent', 'run_code']) expect(() => resolveConfig({ orchestration: { exploreTools: [tool] } })).toThrow()
  })
  it('resolves nested defaults and keeps automatic execution off', () => {
    const config = resolveConfig({ context: { maxChars: 1024 } })
    expect(config.context.maxChars).toBe(1024)
    expect(config.context.historyFacts).toBe(8)
    expect(config.orchestration.auto).toBe(false)
    expect(config.orchestration.requireApproval).toBe(true)
    expect(config.store.approval).toBe('session')
    expect(config.orchestration.maxOutputTokens).toBe(16384)
    expect(resolveConfig({ orchestration: { maxOutputTokens: 4096 } }).orchestration.maxOutputTokens).toBe(4096)
    expect(resolveConfig({ orchestration: { requireApproval: true } }).store.approval).toBe('session')
    expect(resolveConfig().context.maxChars).toBe(6000)
  })

  it.each([
    { context: { maxChars: 40 } },
    { orchestration: { concurrency: 0 } },
    { flags: { patterns: ['['] } },
    { store: { dir: '  ' } },
  ])('rejects an unusable configuration: %j', input => {
    expect(() => resolveConfig(input)).toThrow()
  })

  it('supports spaces and Chinese paths, and rejects the workspace root or escapes', () => {
    const cwd = path.resolve('临时工作区 with spaces')
    expect(resolveStorePath(cwd, resolveConfig())).toBe(path.join(cwd, '.sapper'))
    for (const dir of ['.', '..', '../outside']) {
      expect(() => resolveStorePath(cwd, resolveConfig({ store: { dir } }))).toThrow()
    }
    expect(resolveStorePath(undefined, resolveConfig())).toBeUndefined()
    expect(() => resolveStorePath(cwd, resolveConfig({ store: { mode: 'global' } }))).toThrow(/尚未开放/)
  })
})
