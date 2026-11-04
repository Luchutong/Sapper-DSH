import { describe, expect, it } from 'vitest'
import { ChildBudget } from '../src/orchestration/budget.js'
import { resolveConfig } from '../src/settings.js'
describe('adaptive allowance and finalization reserve', () => {
  it('extends on new evidence, reaches a hard ceiling, and always preserves finalization', () => {
    const config = resolveConfig({ orchestration: { maxChildSteps: 12, maxChildStepsCeiling: 24 } }).orchestration
    const b = new ChildBudget(config, true)
    for (let i = 1; i <= 10; i++) b.next(i)
    expect(b.next(11)).toMatchObject({ extended: true, finalizing: false })
    expect(b.limit).toBe(24)
    for (let i = 12; i <= 22; i++) b.next(i)
    expect(b.next(23)).toMatchObject({ extended: false, finalizing: true })
    expect(b.next(24).exhausted).toBe(false)
    expect(b.next(25).exhausted).toBe(true)
  })
  it('does not endlessly extend repeated work with no new evidence', () => {
    const b = new ChildBudget(resolveConfig({ orchestration: { maxChildSteps: 4, maxChildStepsCeiling: 40 } }).orchestration, true)
    b.next(1); b.next(1)
    expect(b.next(1).extended).toBe(true)
    while (b.steps < b.limit - 2) b.next(1)
    expect(b.next(1)).toMatchObject({ extended: false, finalizing: true })
  })
})
