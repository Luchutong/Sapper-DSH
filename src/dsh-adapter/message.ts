import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'

// DSH 0.2 uses producer-owned message kinds instead of a catch-all `plugin`.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'sapper-dsh': {
      kind: 'sapper-dsh'
      form: 'snapshot' | 'evidence' | 'budget' | 'result' | 'brief'
      sections: readonly ContextSnapshotSection[]
    }
  }
}
