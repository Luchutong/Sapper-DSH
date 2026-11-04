import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import type { ConversationEventRegistry, ConversationNodeAssembler, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Run the pinned SDK's actual registry, history assembler and Chat builder.
 * Browser scheduling notifications are synchronous here; no business reducer is copied.
 */
export async function dshConversation() {
  const require = createRequire(import.meta.url)
  async function regions(pkg: string, names: string[]) {
    const manifest = require.resolve(pkg + '/package.json')
    if (JSON.parse(await readFile(manifest, 'utf8')).version !== '0.2.1-rc.2') throw new Error('Conversation probe requires the pinned SDK')
    const code = await readFile(path.join(path.dirname(manifest), 'lib/client.js'), 'utf8')
    return names.map(name => {
      const marker = '//#region lib/types/client/' + name + '.js', start = code.indexOf(marker), end = code.indexOf('//#endregion', start)
      if (start < 0 || end < start) throw new Error('Published DSH region missing: ' + name)
      return code.slice(start + marker.length, end)
    }).join('\n')
  }
  const conversation = await regions('@deepseek-ai/dsh-client-ui-conversation', ['contract/conversation', 'conversation/definition-registry', 'conversation/event-registry', 'conversation/location-index', 'conversation/assembler'])
  const chat = await regions('@deepseek-ai/dsh-client-ui-chat', ['contract/group-tree', 'conversation-nodes/common', 'contract/chat-nodes', 'contract/chat-visibility', 'conversation-nodes/group-tree-segments', 'conversation-nodes/turn-navigation', 'conversation-nodes/turn-process-presentation', 'conversation-nodes/chat-snapshot-builder'])
  return vm.runInNewContext(conversation + '\n' + chat + '\n({ConversationEventRegistry,ConversationNodeAssembler,chatViewDefinition})', {
    _deepseek_ai_cordis: cordis,
    _deepseek_ai_dsh_client_store: { notifySubscribers: (listeners: Set<() => void>) => { for (const listener of listeners) listener() } },
  }) as {
    ConversationEventRegistry: typeof ConversationEventRegistry
    ConversationNodeAssembler: typeof ConversationNodeAssembler
    chatViewDefinition: ConversationViewDefinition
  }
}
