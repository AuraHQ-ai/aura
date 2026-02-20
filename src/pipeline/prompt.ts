import type { WebClient } from "@slack/web-api";
import { buildSystemPrompt } from "../personality/system-prompt.js";
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

  // Embed the query once, then share the vector with both retrieval functions.
  // If the embedding API is unavailable, degrade gracefully (no memories/conversations).
  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await embedText(context.text);
  } catch (error) {
    logger.error("Embedding failed, proceeding without memory context", {
      error: String(error),
    });
  }

  // Run memory retrieval, conversation retrieval, and profile fetch in parallel
  const [memories, conversations, userProfile] = await Promise.all([
    queryEmbedding
      ? retrieveMemories({
          query: context.text,
          queryEmbedding,
          currentUserId: context.userId,
          limit: 15,
        })
      : Promise.resolve([] as Memory[]),
    queryEmbedding
      ? retrieveConversations({
          query: context.text,
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
  const threadContext = formatConversationContext(
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

  // Build the system prompt (async: queries skill index from DB)
  const systemPrompt = await buildSystemPrompt({
    memories,
    conversations,
    userProfile,
    channelContext,
    channelType: context.channelType,
    userTimezone: userProfile?.timezone || undefined,
    threadContext,
    isChannelHistory,
    modelId,
  });

  logger.debug(`Assembled prompt in ${Date.now() - start}ms`, {
    memoryCount: memories.length,
    conversationCount: conversations.length,
    hasProfile: !!userProfile,
    hasThread: !!threadContext,
  });

  return { systemPrompt, memories, conversations, userProfile };
}
