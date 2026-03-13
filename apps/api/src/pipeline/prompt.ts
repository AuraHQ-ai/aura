import type { WebClient } from "@slack/web-api";
import type { Memory, UserProfile } from "@aura/db/schema";
import type { ConversationThread } from "../memory/retrieve.js";
import type { MessageContext } from "./context.js";
import { resolveChannelName } from "./context.js";
import type { ConversationContext } from "./slack-context.js";
import { formatConversationContext } from "./slack-context.js";
import { buildCorePrompt } from "./core-prompt.js";
import { getProfile } from "../users/profiles.js";

export interface AssembledPrompt {
  stablePrefix: string;
  conversationContext: string;
  dynamicContext: string;
  memories: Memory[];
  conversations: ConversationThread[];
  userProfile: UserProfile | null;
}

/**
 * Assemble the full prompt for a Slack LLM call.
 *
 * Delegates to buildCorePrompt() for the channel-agnostic parts (memory
 * retrieval, profile, personality), then adds Slack-specific enrichments:
 * - Richer query from thread messages
 * - @mention / participant extraction
 * - Slack API conversation context formatting
 * - Channel name resolution via Slack API
 * - Slack List item notification guidance
 */
export async function assemblePrompt(
  context: MessageContext,
  conversation: ConversationContext,
  client?: WebClient,
): Promise<AssembledPrompt> {
  // Build a richer query from thread context for better memory retrieval
  const threadMessages = conversation.thread;
  const queryText =
    threadMessages && threadMessages.length > 1
      ? threadMessages
          .slice(-5)
          .map((m) => m.text)
          .join("\n")
      : context.text;

  // Extract @mentioned user IDs from message text (excluding the sender).
  // By this point, resolveSlackEntities has converted <@U066V1AN6> to @name (U066V1AN6).
  const MENTION_RE = /\((U[A-Z0-9]+)\)/g;

  const threadParticipantIds = (conversation.thread ?? [])
    .map((m) => m.user)
    .filter((id): id is string => !!id);

  const recentParticipantIds = (conversation.recentMessages ?? [])
    .map((m) => m.user)
    .filter((id): id is string => !!id);

  const participantUserIds = [
    ...new Set([
      ...[...(context.text || "").matchAll(MENTION_RE)].map((m) => m[1]),
      ...threadParticipantIds,
      ...recentParticipantIds,
    ]),
  ].filter((id) => id !== context.userId);

  // Fetch user profile early so timezone is available for formatting
  const userProfile = await getProfile(context.userId);
  const userTimezone = userProfile?.timezone || undefined;

  // Resolve channel name via Slack API before building the core prompt
  let channelDisplayName: string | undefined;
  if (!context.isDm && client) {
    const name = await resolveChannelName(client, context.channelId);
    channelDisplayName =
      name !== context.channelId
        ? `#${name} (${context.channelId})`
        : context.channelId;
  }

  // Format conversation context from live Slack data
  const useChannelFallback =
    context.isDm || !!context.threadTs || conversation.auraRecentlyActive;
  const threadContext = await formatConversationContext(
    conversation,
    useChannelFallback,
    userTimezone,
  );

  const isChannelHistory =
    !conversation.thread?.length && !!threadContext && !context.isDm;

  // Delegate to the channel-agnostic core
  const core = await buildCorePrompt({
    channel: "slack",
    userId: context.userId,
    conversationId: context.channelId,
    threadId: context.threadTs,
    messageText: queryText,
    conversationContext: threadContext,
    isDirectMessage: context.isDm,
    userTimezone,
    channelDisplayName,
    isChannelHistory,
    participantUserIds,
    userProfile,
  });

  let dynamicContext = core.dynamicContext;

  // Slack List item notification guidance
  if (context.slackListItemContext) {
    const { messageTs, channelId: listChannelId } =
      context.slackListItemContext;
    dynamicContext += `\n\n## Slack List Item Notification Context

The incoming message is a Slackbot notification about a Slack List item, NOT a real user message.
Do NOT respond to or paraphrase the notification text. Instead, investigate the actual item:

1. Use read_thread_replies(channel: "${listChannelId}", thread_ts: "${messageTs}") to read the item's comment thread and see what changed.
2. Based on the thread content, provide useful triage, context, or follow-up — not a restatement of the notification.

If the thread content is sparse, try list_slack_list_items to find the item by matching thread_ts and get its full field data.`;
  }

  return {
    stablePrefix: core.stablePrefix,
    conversationContext: core.conversationContext,
    dynamicContext,
    memories: core.memories,
    conversations: core.conversations,
    userProfile: core.userProfile,
  };
}
