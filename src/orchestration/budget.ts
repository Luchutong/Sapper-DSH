import type { Config } from '../settings.js'

/** Progress extends a soft allowance; a separate ceiling and finalization reserve remain. */
export class ChildBudget {
  steps = 0
  limit: number
  finalizing = false
  extensions = 0
  private checkpoint = 0
  constructor(private config: Config['orchestration'], private adaptive: boolean) { this.limit = config.maxChildSteps }
  private reserve() { return Math.min(2, Math.max(1, this.limit - 1)) }
  private canExtend(step: number, progress: number) {
    return step > this.limit - this.reserve() && this.adaptive && !this.finalizing && progress > this.checkpoint && this.limit < this.config.maxChildStepsCeiling
  }
  willFinalize(progress: number) {
    return this.finalizing || (this.steps + 1 > this.limit - this.reserve() && !this.canExtend(this.steps + 1, progress))
  }
  next(progress: number) {
    this.steps++
    let extended = false
    const reserve = this.reserve()
    if (this.canExtend(this.steps, progress)) {
      this.checkpoint = progress
      this.limit = Math.min(this.config.maxChildStepsCeiling, this.limit + Math.max(8, this.config.maxChildSteps))
      this.extensions++; extended = true
    }
    this.finalizing ||= this.steps > this.limit - reserve
    return { exhausted: this.steps > this.limit, extended, finalizing: this.finalizing }
  }
}
