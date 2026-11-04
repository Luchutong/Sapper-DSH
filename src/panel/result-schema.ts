import { z } from 'zod'
import type { TaskResult } from './result.js'
/** Restored plugin records are opaque SDK data; validate before displaying them. */
const schema = z
  .object({
    job_id: z.string(),
    task_id: z.string(),
    goal: z.string(),
    state: z.string(),
    summary: z.string(),
    attachments: z.array(z.object({ id: z.string(), name: z.string(), path: z.string(), bytes: z.number().nonnegative(), sha256: z.string().optional() })).optional(),
    wp_path: z.string().optional(),
    session_id: z.string().optional(),
    run_id: z.string().optional(),
    stop_reason: z.string().optional(),
    phase: z
      .enum(['accepted', 'progress', 'direction', 'flag-found', 'result'])
      .optional(),
    activity: z
      .array(z.object({ at: z.string(), stage: z.string() }))
      .optional(),
    confirmed: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        kind: z.string(),
      }),
    ),
    candidates: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        kind: z.string(),
        status: z.enum(['unverified', 'rejected']),
      }),
    ),
    errors: z.array(z.string()),
  })
  .passthrough()
export function readResult(data: unknown): TaskResult | undefined {
  const parsed = schema.safeParse(data)
  return parsed.success ? (parsed.data as TaskResult) : undefined
}
