import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { safePath } from './io.js'
import { GraphStore } from './graph.js'

export interface ProjectSummary {
  goal: string
  status: 'active' | 'completed'
}

/** Lightweight goal-only context; retains read access to historical M0 fixtures. */
export async function readProjectSummary(root: string, boundary = path.dirname(root)): Promise<ProjectSummary | undefined> {
  const store = new GraphStore(root, boundary)
  await store.checkReadable()
  await safePath(path.join(root, 'project.json'), boundary)
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path.join(root, 'project.json')))
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
  await store.checkReadable()
  return { goal: project.goal, status: project.status }
}
