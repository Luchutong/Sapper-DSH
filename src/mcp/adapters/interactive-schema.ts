import { z } from 'zod'
const native = z.string().regex(/^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/)
export const nativeOperationSchema = z.object({ tool: native, arguments: z.record(z.string(), z.json()).default({}) }).strict()
export const interactionAdapterSchema = z.object({
  start: nativeOperationSchema, read: nativeOperationSchema, write: nativeOperationSchema, stop: nativeOperationSchema,
  interrupt: nativeOperationSchema.optional(), snapshot: nativeOperationSchema.optional(),
  sessionPath: z.string().min(1), outputPath: z.string().min(1),
  stopConfirmsExit: z.boolean().default(false),
  statePath: z.string().min(1).optional(), outputEncoding: z.enum(['utf-8', 'base64']).default('utf-8'),
}).strict()
export type InteractionAdapter = z.infer<typeof interactionAdapterSchema>
export const interactionRequestSchema = z.object({
  action: z.enum(['start', 'read', 'write', 'interrupt', 'stop', 'snapshot']), requestId: z.string().uuid(),
  profileId: z.string().optional(), sessionRef: z.string().uuid().optional(), data: z.string().max(1400000).optional(),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'), cursor: z.number().int().min(0).default(0),
  waitMs: z.number().int().min(0).max(30000).default(1000), maxBytes: z.number().int().min(1).max(1048576).default(16384),
}).strict()
export type InteractionRequest = z.infer<typeof interactionRequestSchema>
