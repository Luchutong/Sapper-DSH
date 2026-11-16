import { matchesTool } from '../orchestration/tool-policy.js'
import type { BrokerOwner, BrokerPolicy, ToolProfile } from './contracts.js'
export function inferCapabilities(text: string): string[] {
  const out = new Set<string>()
  if (/\b(elf|pe|binary|libc|loader|disassembl|decompil|ida|rop|pwn)\b|二进制|逆向|反编译|汇编/i.test(text)) out.add('binary')
  if (/\b(gdb|debug|canary|inferior|aslr|register|stack|heap)\b|调试|栈|堆|寄存器|运行时地址/i.test(text)) { out.add('debug'); out.add('binary') }
  if (/https?:\/\/|\b(web|browser|http|cookie|playwright)\b|网页|浏览器/i.test(text)) out.add('web')
  if (/\b(sql|mysql|postgres|database|sqlite)\b|数据库|数据表/i.test(text)) out.add('db')
  return [...out]
}
export const mcpTool = (name: string) => name.startsWith('mcp__')
export function routeTool(name: string, owner: BrokerOwner, policy: BrokerPolicy, requested: string[], text: string, hasProvider: (id: string) => boolean): { profile?: ToolProfile; allowed: boolean; reason: string } {
  if (owner.purpose === 'writeup') return { allowed: false, reason: 'WP 阶段只读历史与本地文件；补测请新建求解阶段' }
  const matches = policy.profiles.filter((p) => matchesTool(p.selectors, name))
  if (!matches.length) return { allowed: true, reason: '未分类 MCP：共享保守串行域，目标身份未认证' }
  // Overlapping aliases cannot be used to route around an unavailable/denied group.
  if (new Set(matches.map((p) => p.backendId)).size > 1) return { allowed: false, reason: '配置组重叠且物理后端不同，请消除歧义' }
  const profile = matches.sort((a, b) => Math.max(...b.selectors.map((s) => s.length)) - Math.max(...a.selectors.map((s) => s.length)))[0]!
  if (profile.workspaceIds.length && !profile.workspaceIds.includes(owner.workspaceId)) return { profile, allowed: false, reason: '资源配置组不属于当前工作区' }
  if (owner.role !== 'main' && (owner.role === 'reason' || !profile.roles.includes(owner.role))) return { profile, allowed: false, reason: '角色不允许该资源配置组' }
  if (profile.providerId && !hasProvider(profile.providerId)) return { profile, allowed: false, reason: '资源实例提供者尚未注册' }
  const needed = requested.length ? requested : inferCapabilities(text)
  if (owner.role !== 'main' && policy.selection === 'auto' && needed.length && profile.capabilities.length && !needed.some((c) => profile.capabilities.some((p) => p === c || p.startsWith(c + '.') || c.startsWith(p + '.'))))
    return { profile, allowed: false, reason: '当前意图所需能力与该资源组不同；可显式请求其他能力' }
  return { profile, allowed: true, reason: profile.isolation === 'exclusive-workflow' ? '按物理后端持有工作流独占租约' : '使用资源配置组' }
}
export function resourceKey(profile?: ToolProfile): string {
  // All unclassified names share one domain: aliases cannot evade the fallback lock.
  return profile ? 'backend:' + profile.backendId : 'unclassified:mcp'
}
