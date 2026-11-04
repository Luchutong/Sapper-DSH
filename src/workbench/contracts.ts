import { z } from 'zod'
import type { PanelState, PanelAction } from '../panel/rpc.js'
import type { TaskResult } from '../panel/result.js'

export const modelSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().optional(),
  })
  .strict()
export const preferencesSchema = z
  .object({
    rootDir: z.string().default(''),
    parallelism: z.number().int().min(1).max(8).default(2),
    model: modelSchema.optional(),
    agentPreset: z.string().optional(),
    permissionPreset: z.string().optional(),
  })
  .strict()
export type Preferences = z.infer<typeof preferencesSchema>
export const launchSchema = z
  .object({
    requestId: z.string().uuid(),
    rootDir: z.string().min(1),
    title: z.string().max(120).default(''),
    goal: z.string().min(1).max(8000),
    model: modelSchema.optional(),
    agentPreset: z.string().optional(),
    permissionPreset: z.string().optional(),
  })
  .strict()
export type LaunchInput = z.infer<typeof launchSchema>
export interface LaunchRecord {
  requestId: string
  input: LaunchInput
  cwd: string
  title: string
  sessionId?: string
  workspaceId?: string
  jobId?: string
  error?: string
  createdAt: string
}
export type JobState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export interface JobRecord {
  id: string
  sessionId: string
  cwd: string
  goal: string
  input: PanelAction
  state: JobState
  createdAt: string
  taskId?: string
  result?: TaskResult
  error?: string
  stage?: string
  next?: { goal: string; purpose: 'solve' | 'writeup' }
}
export interface BriefRecord {
  jobId: string
  sessionId: string
  messageId: string
  state: 'queued' | 'running' | 'completed' | 'failed'
  error?: string
}
export interface WorkbenchData {
  preferences: Preferences
  launches: Record<string, LaunchRecord>
  jobs: Record<string, JobRecord>
  briefs: Record<string, BriefRecord>
  seen: Record<string, string>
}
export interface TaskAddress {
  workspaceId: string
  taskId: string
  runId?: string | undefined
}
export const addressSchema = z
  .object({
    workspaceId: z.string().min(1),
    taskId: z.string().min(1),
    runId: z.string().optional(),
  })
  .strict()
export interface Phase {
  taskId: string
  goal: string
  purpose: string
  status: string
  runs: Array<{
    id: string
    state: string
    stopReason?: string
    updatedAt: string
  }>
}
export interface Challenge {
  id: string
  workspaceId: string
  taskId: string
  sessionId: string
  cwd: string
  title: string
  goal: string
  state: string
  updatedAt: string
  createdAt: string
  unread: boolean
  phases: Phase[]
  job?: JobRecord
  flags: Array<{
    value: string
    status: 'candidate' | 'confirmed' | 'rejected'
  }>
  error?: string
}
export interface WorkbenchSnapshot {
  preferences: Preferences
  durable: boolean
  available: boolean
  launches: LaunchRecord[]
  challenges: Challenge[]
  jobs: JobRecord[]
  briefs: BriefRecord[]
  defaults: {
    model?: Preferences['model']
    agentPreset?: string
    permissionPreset?: string
    permissions: Array<{ id: string; label: string }>
    presets: string[]
  }
}
export interface TaskDetail {
  address: TaskAddress
  state: PanelState
  result?: TaskResult
  evidence: Array<{
    intentId: string
    role: string
    sessionId: string
    tool: string
    excerpt: string
    sha256?: string
  }>
  files: Array<{ name: string; size: number; snapshot?: boolean }>
  hiddenNodes: number
  totalNodes: number
}
export interface WorkbenchApi {
  overview(): Promise<WorkbenchSnapshot>
  preferences(input: Preferences): Promise<Preferences>
  launch(input: LaunchInput): Promise<LaunchRecord>
  detail(input: TaskAddress): Promise<TaskDetail>
  taskAction(input: TaskAddress, action: PanelAction): Promise<unknown>
  file(
    input: TaskAddress,
    name: string,
  ): Promise<{ text: string; truncated: boolean }>
  node(
    input: TaskAddress,
    id: string,
  ): Promise<{ title?: string; description: string; doc?: string }>
  seen(id: string): Promise<void>
  retryBrief(jobId: string): Promise<void>
}
