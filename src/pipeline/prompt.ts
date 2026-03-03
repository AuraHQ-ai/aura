import type { WebClient } from "@slack/web-api";
import { buildSystemPrompt, buildDynamicContext, type MentionedPerson } from "../personality/system-prompt.js";
import { retrieveMemories, retrieveConversations, type ConversationThread } from "../memory/retrieve.js";
import { embedText } from "../lib/embeddings.js";
import { getProfile } from "../users/profiles.js";
import type { MessageContext } from "./context.js";
import { resolveChannelName } from "./context.js";
import type { ConversationContext } from "./slack-context.js";
import { formatConversationContext } from "./slack-context.js";
import type { Memory, UserProfile } from "../db/schema.js";
import { people } from "../db/schema.js";
import { db } from "../db/client.js";
import { inArray, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { logger } from "../lib/logger.js";
import { getMainModelId } from "../lib/ai.js";

export interface AssembledPrompt {
  /** Stable across all requests: personality + self-directive + notes-index + skill-index (cached globally) */
  stablePrefix: string;
  /** Stable within a conversation thread: channel + user + memories + conversations + thread (cached per-thread) */
  conversationContext: string;
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

  // Extract @mentioned user IDs from message text (excluding the sender).
  // By this point, resolveSlackEntities has converted <@U066V1AN6> to @name (U066V1AN6).
  const MENTION_RE = /\((U[A-Z0-9]+)\)/g;
  const mentionedUserIds = [...new Set(
    [...(context.text || '').matchAll(MENTION_RE)].map(m => m[1])
  )].filter(id => id !== context.userId);

  // Run memory retrieval, conversation retrieval, profile fetch, and mentioned-people lookup in parallel
  const [memories, conversations, userProfile, mentionedPeople] = await Promise.all([
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
    lookupMentionedPeople(mentionedUserIds),
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

  // Build the system prompt layers (async: queries skill index from DB)
  const { stablePrefix, conversationContext } = await buildSystemPrompt({
    memories,
    conversations,
    userProfile,
    channelContext,
    channelType: context.channelType,
    threadContext,
    isChannelHistory,
    mentionedPeople,
  });

  // Dynamic per-call context — separated so the stable prompt stays cache-friendly
  let dynamicContext = buildDynamicContext({
    userTimezone: userProfile?.timezone || undefined,
    modelId,
    channelId: context.channelId,
    threadTs: context.threadTs,
  });

  // Inject guidance for USLACKBOT list notifications so the LLM investigates
  // the actual list item instead of responding to the generic notification text.
  if (context.slackListItemContext) {
    const { messageTs, channelId: listChannelId } = context.slackListItemContext;
    dynamicContext += `\n\n## Slack List Item Notification Context

The incoming message is a Slackbot notification about a Slack List item, NOT a real user message.
Do NOT respond to or paraphrase the notification text. Instead, investigate the actual item:

1. Use read_thread_replies(channel: "${listChannelId}", thread_ts: "${messageTs}") to read the item's comment thread and see what changed.
2. Based on the thread content, provide useful triage, context, or follow-up — not a restatement of the notification.

If the thread content is sparse, try list_slack_list_items to find the item by matching thread_ts and get its full field data.`;
  }

  logger.debug(`Assembled prompt in ${Date.now() - start}ms`, {
    memoryCount: memories.length,
    conversationCount: conversations.length,
    hasProfile: !!userProfile,
    hasThread: !!threadContext,
    hasSlackListItemContext: !!context.slackListItemContext,
    mentionedPeopleCount: mentionedPeople.length,
  });

  return { stablePrefix, conversationContext, dynamicContext, memories, conversations, userProfile };
}

/**
 * Look up @mentioned Slack users in the people DB.
 * Uses a single query with a left-join to resolve manager names.
 */
async function lookupMentionedPeople(slackUserIds: string[]): Promise<MentionedPerson[]> {
  if (slackUserIds.length === 0) return [];

  try {
    const manager = alias(people, 'manager');
    const rows = await db
      .select({
        slackUserId: people.slackUserId,
        displayName: people.displayName,
        gender: people.gender,
        preferredLanguage: people.preferredLanguage,
        jobTitle: people.jobTitle,
        managerName: manager.displayName,
        notes: people.notes,
      })
      .from(people)
      .leftJoin(manager, eq(people.managerId, manager.id))
      .where(inArray(people.slackUserId, slackUserIds));

    return rows
      .filter((r): r is typeof r & { slackUserId: string } => r.slackUserId !== null)
      .map(r => ({
        slackUserId: r.slackUserId,
        displayName: r.displayName,
        gender: r.gender,
        preferredLanguage: r.preferredLanguage,
        jobTitle: r.jobTitle,
        managerName: r.managerName,
        notes: r.notes,
      }));
  } catch (error) {
    logger.error("Failed to look up mentioned people", { error: String(error), slackUserIds });
    return [];
  }
}
