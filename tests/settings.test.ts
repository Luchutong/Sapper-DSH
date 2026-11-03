import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/settings.js'
import { resolveStorePath } from '../src/store/paths.js'
import path from 'node:path'

describe('settings and workspace boundary', () => {
  it('resolves nested defaults and keeps automatic execution off', () => {
    const config = resolveConfig({ context: { maxChars: 1024 } })
    expect(config.context.maxChars).toBe(1024)
    expect(config.context.historyFacts).toBe(8)
    expect(config.orchestration.auto).toBe(false)
    expect(config.orchestration.requireApproval).toBe(true)
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
    expect(() => resolveStorePath(cwd, resolveConfig({ store: { mode: 'global' } }))).toThrow(/M1/)
  })
})
