import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ProjectSummary {
  goal: string
  status: 'active' | 'completed'
}

/** Read-only M0 probe. Full schema validation and node IO belong to M1. */
export async function readProjectSummary(root: string): Promise<ProjectSummary | undefined> {
  let content: string
  try {
    content = await readFile(path.join(root, 'project.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const project: unknown = JSON.parse(content)
  if (typeof project !== 'object' || project === null || !('goal' in project) ||
      typeof project.goal !== 'string' || !('status' in project) ||
      (project.status !== 'active' && project.status !== 'completed')) {
    throw new Error('project.json 缺少有效的 goal / status；未修改原图')
  }
  return { goal: project.goal, status: project.status }
}
