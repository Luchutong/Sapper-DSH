/** Only MCP namespace prefixes accept a trailing wildcard. Other tools stay exact. */
export const EXPLORE_TOOLS = ['read', 'glob', 'grep', 'bash', 'pwsh', 'web_search', 'web_fetch', 'mcp__*']
export const VERIFY_TOOLS = ['read', 'glob', 'grep', 'bash', 'pwsh', 'mcp__*']
const reserved = new Set(['structured_output', 'run_code', 'subagent', 'send_message', 'interrupt_agent'])
export const externalTool = (name: string) => !name.startsWith('sapper_') && !reserved.has(name)
export function validToolSelector(value: string): boolean {
  return externalTool(value) && (/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(value) || /^mcp__(?:[a-zA-Z0-9_.-]+__)?\*$/.test(value))
}
export function matchesTool(selectors: readonly string[], name: string): boolean {
  return externalTool(name) && selectors.some((s) => s.endsWith('*') ? validToolSelector(s) && name.startsWith(s.slice(0, -1)) : s === name)
}
export function mcpPrefix(name: string): string | undefined {
  const server = /^mcp__([^]*?)__/.exec(name)?.[1]
  return server ? `mcp__${server}__*` : undefined
}
