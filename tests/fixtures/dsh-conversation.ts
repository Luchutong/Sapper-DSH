import type { ConversationEventRegistry, ConversationNodeAssembler, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { dshClientProbe } from './dsh-client-artifact.js'

/** Run the pinned SDK's actual registry, history assembler and Chat builder. */
export async function dshConversation() {
  const [conversation, chat] = await Promise.all([
    dshClientProbe<{
      ConversationEventRegistry: typeof ConversationEventRegistry
      ConversationNodeAssembler: typeof ConversationNodeAssembler
    }>('@deepseek-ai/dsh-client-ui-conversation'),
    dshClientProbe<{ chatViewDefinition: ConversationViewDefinition }>('@deepseek-ai/dsh-client-ui-chat', ['chatViewDefinition']),
  ])
  return { ...conversation, ...chat }
}
