import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Config } from '../settings.js'
import { externalTool, matchesTool, mcpPrefix } from '../orchestration/tool-policy.js'
import { StoreError } from '../store/validation.js'

export interface ModelCapability {
  provider: string; id: string; name: string
  efforts: Array<{ id: string; name: string; description?: string }>
  defaultEffort?: string
}
export interface Capabilities {
  sessions: Array<{ id: string; cwd: string }>
  sessionId?: string
  currentModel?: { provider: string; model: string; reasoningEffort?: string }
  tools: Array<{ name: string; description: string; prefix?: string; available: boolean; explore: boolean; verify: boolean }>
  models: ModelCapability[]
  warnings: string[]
}
export async function capabilities(ctx: Context, config: Config, sessionId?: string): Promise<Capabilities> {
  const roots = ctx.agents.roots(), parent = sessionId ? roots.find((a) => a.id === SessionId(sessionId)) : undefined
  if (sessionId && !parent) throw new StoreError('该主会话尚未打开，请在 DSH 打开后刷新工具范围')
  const selected = parent?.session.requestHeader()?.config ?? parent?.options ?? ctx.get('agentDefaultModel')?.currentSelection()
  const warnings: string[] = [], llm = ctx.get('llm'), models: ModelCapability[] = []
  const routes = new Map<string, { provider: string; id: string; name: string }>()
  if (llm) {
    await Promise.all(llm.listProviders().map(async (provider) => {
      try { for (const m of await llm.listModels(provider.id)) routes.set(`${provider.id}:${m.id}`, { provider: provider.id, id: m.id, name: m.name }) }
      catch { warnings.push(`无法读取 ${provider.id} 的模型目录`) }
    }))
    if (selected?.provider && selected.model) routes.set(`${selected.provider}:${selected.model}`, { provider: selected.provider, id: selected.model, name: selected.model })
    for (const value of Object.values(config.orchestration.models)) if (value !== 'inherit') {
      const colon = value.indexOf(':'), provider = colon >= 0 ? value.slice(0, colon) : selected?.provider, id = colon >= 0 ? value.slice(colon + 1) : value
      if (provider && !routes.has(`${provider}:${id}`)) routes.set(`${provider}:${id}`, { provider, id, name: id })
    }
    await Promise.all([...routes.values()].map(async (m) => {
      try {
        const info = await llm.resolveModelInfo(m.provider, m.id)
        models.push({ ...m, efforts: (info.reasoning?.efforts ?? []).map((e) => ({ id: String(e.id), name: e.name, ...(e.description ? { description: e.description } : {}) })),
          ...(info.reasoning?.defaultEffort ? { defaultEffort: String(info.reasoning.defaultEffort) } : {}) })
      } catch { models.push({ ...m, efforts: [] }); warnings.push(`无法读取 ${m.provider}:${m.id} 的推理档位`) }
    }))
  }
  const inherited = parent ? scopeParentOf(parent) : undefined
  const schemas = new Map([...ctx.tools.schemas(inherited), ...(parent ? ctx.tools.schemas(parent) : [])].map((t) => [t.name, t]))
  return { sessions: roots.filter((a) => a.session.header.cwd).map((a) => ({ id: String(a.id), cwd: a.session.header.cwd! })),
    ...(parent ? { sessionId: String(parent.id) } : {}),
    ...(selected?.provider && selected.model ? { currentModel: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: String(selected.reasoningEffort) } : {}) } } : {}),
    tools: [...schemas.values()].filter((t) => externalTool(t.name)).map((t) => {
      const available = !!ctx.tools.get(t.name, parent), prefix = mcpPrefix(t.name)
      return { name: t.name, description: t.description.slice(0, 600), available, ...(prefix ? { prefix } : {}),
        explore: available && matchesTool(config.orchestration.exploreTools, t.name), verify: available && matchesTool(config.orchestration.verifyTools, t.name) }
    }).sort((a, b) => a.name.localeCompare(b.name)), models: models.sort((a,b) => (a.provider + a.id).localeCompare(b.provider + b.id)), warnings }
}
