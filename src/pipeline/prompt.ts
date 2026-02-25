import type { WebClient } from "@slack/web-api";
import { buildSystemPrompt, buildDynamicContext } from "../personality/system-prompt.js";
import { retrieveMemories, retrieveConversations, type ConversationThread } from "../memory/retrieve.js";
import { embedText } from "../lib/embeddings.js";
import { getProfile } from "../users/profiles.js";
import type { MessageContext } from "./context.js";
import { resolveChannelName } from "./context.js";
import type { ConversationContext } from "./slack-context.js";
import { formatConversationContext } from "./slack-context.js";
import type { Memory, UserProfile } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { getMainModelId } from "../lib/ai.js";

export interface AssembledPrompt {
  systemPrompt: string;
  /** Dynamic per-call context (time, model, channel, thread) — passed as a separate uncached system message */
  dynamicContext: string;
  memories: Memory[];
  conversations: ConversationThread[];
  userProfile: UserProfile | null;
}

/**
 * Assemble the full prompt for an LLM call.
 *
 * Steps:
 * 1. Embed the query once, then retrieve memories + conversations in parallel
 * 2. Fetch user profile for tone adaptation
 * 3. Format live conversation context from Slack API (already fetched)
 * 4. Build the system prompt with all context injected
 */
export async function assemblePrompt(
  context: MessageContext,
  conversation: ConversationContext,
  client?: WebClient,
): Promise<AssembledPrompt> {
  const start = Date.now();

  // Build a richer query from thread context for better memory retrieval.
  // Use the last 5 thread messages instead of just the latest message,
  // falling back to the single message text if no thread is available.
  const threadMessages = conversation.thread;
  const queryText = threadMessages && threadMessages.length > 1
    ? threadMessages.slice(-5).map(m => m.text).join('\n')
    : context.text;

  // Embed the query once, then share the vector with both retrieval functions.
  // If the embedding API is unavailable, degrade gracefully (no memories/conversations).
  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await embedText(queryText);
  } catch (error) {
    logger.error("Embedding failed, proceeding without memory context", {
      error: String(error),
    });
  }

  // Run memory retrieval, conversation retrieval, and profile fetch in parallel
  const [memories, conversations, userProfile] = await Promise.all([
    queryEmbedding
      ? retrieveMemories({
          query: queryText,
          queryEmbedding,
          currentUserId: context.userId,
          limit: 15,
        })
      : Promise.resolve([] as Memory[]),
    queryEmbedding
      ? retrieveConversations({
          query: queryText,
          queryEmbedding,
          threadLimit: 3,
          matchLimit: 15,
          minSimilarity: 0.35,
          excludeThreadTs: context.threadTs,
        })
      : Promise.resolve([] as ConversationThread[]),
    getProfile(context.userId),
  ]);

  // Format conversation context from live Slack data (already fetched by pipeline).
  // Include channel-history fallback for DMs, threaded messages, and when Aura
  // is recently active in the channel (Tier 3) — otherwise the response LLM
  // would have no conversation context despite the shouldRespond gate seeing it.
  const useChannelFallback =
    context.isDm || !!context.threadTs || conversation.auraRecentlyActive;
  const threadContext = await formatConversationContext(
    conversation,
    useChannelFallback,
    userProfile?.timezone || undefined,
  );

  // Resolve channel ID to human-readable name (e.g. C0BNVKS77 -> #dev)
  let channelContext: string;
  if (context.isDm) {
    channelContext = "DM";
  } else if (client) {
    const name = await resolveChannelName(client, context.channelId);
    channelContext = name !== context.channelId ? `#${name} (${context.channelId})` : context.channelId;
  } else {
    channelContext = context.channelId;
  }

  // The context is "channel history" (not a thread) when there's no thread
  // data and we fell back to recent channel messages.
  const isChannelHistory =
    !conversation.thread && !!threadContext && !context.isDm;

  // Resolve active model ID for self-awareness in system prompt
  const modelId = await getMainModelId();

  // Build the stable system prompt (async: queries skill index from DB)
  const systemPrompt = await buildSystemPrompt({
    memories,
    conversations,
    userProfile,
    channelContext,
    channelType: context.channelType,
    threadContext,
    isChannelHistory,
  });

  // Dynamic per-call context — separated so the stable prompt stays cache-friendly
  const dynamicContext = buildDynamicContext({
    userTimezone: userProfile?.timezone || undefined,
    modelId,
    channelId: context.channelId,
    threadTs: context.threadTs,
  });

  logger.debug(`Assembled prompt in ${Date.now() - start}ms`, {
    memoryCount: memories.length,
    conversationCount: conversations.length,
    hasProfile: !!userProfile,
    hasThread: !!threadContext,
  });

  return { systemPrompt, dynamicContext, memories, conversations, userProfile };
}
