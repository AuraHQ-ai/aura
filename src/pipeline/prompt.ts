import { buildSystemPrompt } from "../personality/system-prompt.js";
import { retrieveMemories } from "../memory/retrieve.js";
import { getProfile } from "../users/profiles.js";
import type { MessageContext } from "./context.js";
import type { ConversationContext } from "./slack-context.js";
import { formatConversationContext } from "./slack-context.js";
import type { Memory, UserProfile } from "../db/schema.js";
import { logger } from "../lib/logger.js";

export interface AssembledPrompt {
  systemPrompt: string;
  memories: Memory[];
  userProfile: UserProfile | null;
}

/**
 * Assemble the full prompt for an LLM call.
 *
 * Steps:
 * 1. Retrieve relevant memories via semantic search (long-term knowledge)
 * 2. Fetch user profile for tone adaptation
 * 3. Format live conversation context from Slack API (already fetched)
 * 4. Build the system prompt with all context injected
 */
export async function assemblePrompt(
  context: MessageContext,
  conversation: ConversationContext,
): Promise<AssembledPrompt> {
  const start = Date.now();

  // Run memory retrieval and profile fetch in parallel
  const [memories, userProfile] = await Promise.all([
    retrieveMemories({
      query: context.text,
      currentUserId: context.userId,
      limit: 15,
    }),
    getProfile(context.userId),
  ]);

  // Format conversation context from live Slack data (already fetched by pipeline).
  // Include channel-history fallback for DMs, threaded messages, and when Aura
  // is recently active in the channel (Tier 3) — otherwise the response LLM
  // would have no conversation context despite the shouldRespond gate seeing it.
  const useChannelFallback =
    context.isDm || !!context.threadTs || conversation.auraRecentlyActive;
  const threadContext = formatConversationContext(conversation, useChannelFallback);

  // Determine channel context string
  const channelContext = context.isDm ? "DM" : context.channelId;

  // The context is "channel history" (not a thread) when there's no thread
  // data and we fell back to recent channel messages.
  const isChannelHistory =
    !conversation.thread && !!threadContext && !context.isDm;

  // Build the system prompt (async: queries skill index from DB)
  const systemPrompt = await buildSystemPrompt({
    memories,
    userProfile,
    channelContext,
    channelType: context.channelType,
    userTimezone: userProfile?.timezone || undefined,
    threadContext,
    isChannelHistory,
  });

  logger.debug(`Assembled prompt in ${Date.now() - start}ms`, {
    memoryCount: memories.length,
    hasProfile: !!userProfile,
    hasThread: !!threadContext,
  });

  return { systemPrompt, memories, userProfile };
}
