import { buildSystemPrompt } from "../personality/system-prompt.js";
import { retrieveMemories } from "../memory/retrieve.js";
import { getThreadMessages, getRecentChannelMessages } from "../memory/store.js";
import { getProfile } from "../users/profiles.js";
import type { MessageContext } from "./context.js";
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
 * 1. Retrieve relevant memories via semantic search
 * 2. Fetch user profile for tone adaptation
 * 3. Fetch thread context (if in a thread)
 * 4. Build the system prompt with all context injected
 */
export async function assemblePrompt(
  context: MessageContext,
): Promise<AssembledPrompt> {
  const start = Date.now();

  // Run memory retrieval, profile fetch, and thread context in parallel
  const [memories, userProfile, threadMessages] = await Promise.all([
    retrieveMemories({
      query: context.text,
      currentUserId: context.userId,
      limit: 15,
    }),
    getProfile(context.userId),
    context.threadTs
      ? getThreadMessages(context.threadTs, context.channelId, 15)
      : context.isDm
        ? getRecentChannelMessages(context.channelId, 15)
        : Promise.resolve([]),
  ]);

  // Format thread context as conversation text
  let threadContext: string | undefined;
  if (threadMessages.length > 0) {
    // Reverse so oldest messages come first
    const sorted = [...threadMessages].reverse();
    threadContext = sorted
      .map((m) => `${m.role === "assistant" ? "Aura" : m.userId}: ${m.content}`)
      .join("\n\n");
  }

  // Determine channel context string
  const channelContext = context.isDm ? "DM" : context.channelId;

  // Build the system prompt
  const systemPrompt = buildSystemPrompt({
    memories,
    userProfile,
    channelContext,
    channelType: context.channelType,
    userTimezone: userProfile?.timezone || undefined,
    threadContext,
  });

  logger.debug(`Assembled prompt in ${Date.now() - start}ms`, {
    memoryCount: memories.length,
    hasProfile: !!userProfile,
    hasThread: !!threadContext,
  });

  return { systemPrompt, memories, userProfile };
}
