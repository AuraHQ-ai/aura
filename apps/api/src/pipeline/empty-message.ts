import type { MessageContext } from "./context.js";
import type { ConversationContext } from "./slack-context.js";

export const BARE_MENTION_WITH_CONTEXT_PROMPT =
  "Aura was mentioned without additional text. Use the surrounding Slack context to answer the latest unanswered message or request.";

function hasContextMessage(
  message: { text: string; ts: string },
  currentMessageTs: string,
): boolean {
  return message.ts !== currentMessageTs && message.text.trim().length > 0;
}

export function hasSurroundingConversationContext(
  conversation: ConversationContext | undefined,
  currentMessageTs: string,
): boolean {
  if (!conversation) return false;
  return (
    (conversation.thread ?? []).some((message) =>
      hasContextMessage(message, currentMessageTs),
    ) ||
    conversation.recentMessages.some((message) =>
      hasContextMessage(message, currentMessageTs),
    )
  );
}

export function shouldGreetAndBailForEmptyMessage(
  context: Pick<MessageContext, "isMentioned" | "messageTs">,
  conversation: ConversationContext | undefined,
): boolean {
  return (
    !context.isMentioned ||
    !hasSurroundingConversationContext(conversation, context.messageTs)
  );
}
