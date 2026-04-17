import {
  buildSystemPrompt,
  buildDynamicContext,
  type PersonProfile,
  type EntitySummary,
} from "../personality/system-prompt.js";
import {
  retrieveMemories,
  retrieveConversations,
  type ConversationThread,
} from "../memory/retrieve.js";
import { embedText } from "../lib/embeddings.js";
import { getProfile } from "../users/profiles.js";
import { getMainModelId } from "../lib/ai.js";
import type { Memory, UserProfile } from "@aura/db/schema";
import { users, entities } from "@aura/db/schema";
import { db } from "../db/client.js";
import { inArray, eq, and, sql, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { logger } from "../lib/logger.js";
import {
  retrieveSkillsForTurn,
  logSkillRetrievals,
  type RetrievedSkill,
} from "../skills/retrieve.js";

// Re-export for consumers that previously imported from prompt.ts
export type { PersonProfile };

// ── Channel Session ──────────────────────────────────────────────────────────

export type ChannelType = "dm" | "dashboard" | "public_channel" | "private_channel";

export interface ChannelSession {
  channel: "slack" | "dashboard";
  userId: string;
  /** Per-message/turn identifier for retrieval telemetry. */
  turnId?: string;
  conversationId: string;
  threadId?: string;
  messageText: string;
  /** Pre-formatted recent messages — each connector provides its own format. */
  conversationContext?: string;
  isDirectMessage: boolean;
  /** Specific channel type — when omitted, derived from isDirectMessage (dm vs public_channel). */
  channelType?: ChannelType;
  userTimezone?: string;
  /** Human-readable channel name (e.g. "#dev (C0BNVKS77)"). Falls back to conversationId. */
  channelDisplayName?: string;
  /** True when conversationContext contains recent channel messages rather than a thread. */
  isChannelHistory?: boolean;
  /** Additional user IDs to look up in the people DB (e.g. thread participants). */
  participantUserIds?: string[];
  /** Pre-fetched user profile to avoid redundant DB lookups. */
  userProfile?: UserProfile | null;
  /** Override the model ID injected into the dynamic context (e.g. when the dashboard user selects a specific model). */
  modelIdOverride?: string;
}

// ── Usage Stats ──────────────────────────────────────────────────────────────

const USAGE_STATS_TTL_MS = 5 * 60 * 1000; // 5 minutes
let usageStatsCache: { value: string; expiresAt: number } | null = null;

function arrow(current: number, previous: number): string {
  if (previous === 0) return "";
  if (current > previous) return "↑";
  if (current < previous) return "↓";
  return "→";
}

export async function getUsageStats(): Promise<string> {
  if (usageStatsCache && Date.now() < usageStatsCache.expiresAt) {
    return usageStatsCache.value;
  }
  try {
    interface UsageRow {
      users_this_week: string;
      users_last_week: string;
      received_this_week: string;
      sent_this_week: string;
      received_last_week: string;
      sent_last_week: string;
    }

    const result = await db.execute(sql`
      SELECT
        COUNT(DISTINCT CASE WHEN created_at > now() - INTERVAL '7 days' AND role = 'user' THEN user_id END) AS users_this_week,
        COUNT(DISTINCT CASE WHEN created_at > now() - INTERVAL '14 days' AND created_at <= now() - INTERVAL '7 days' AND role = 'user' THEN user_id END) AS users_last_week,
        COUNT(CASE WHEN created_at > now() - INTERVAL '7 days' AND role = 'user' THEN 1 END) AS received_this_week,
        COUNT(CASE WHEN created_at > now() - INTERVAL '7 days' AND role = 'assistant' THEN 1 END) AS sent_this_week,
        COUNT(CASE WHEN created_at > now() - INTERVAL '14 days' AND created_at <= now() - INTERVAL '7 days' AND role = 'user' THEN 1 END) AS received_last_week,
        COUNT(CASE WHEN created_at > now() - INTERVAL '14 days' AND created_at <= now() - INTERVAL '7 days' AND role = 'assistant' THEN 1 END) AS sent_last_week
      FROM messages
      WHERE created_at > now() - INTERVAL '14 days'
        AND role IN ('user', 'assistant')
    `);

    const resultRows = ((result as any).rows ?? result) as UsageRow[];
    const r = resultRows[0];
    if (!r) return "";

    const usersNow = Number(r.users_this_week);
    const usersPrev = Number(r.users_last_week);
    const recvNow = Number(r.received_this_week);
    const sentNow = Number(r.sent_this_week);
    const recvPrev = Number(r.received_last_week);
    const sentPrev = Number(r.sent_last_week);

    const usersArrow = arrow(usersNow, usersPrev);
    const usersDetail = usersPrev > 0
      ? ` (${usersArrow} from ${usersPrev} prior week)`
      : "";

    const msgArrow = arrow(recvNow + sentNow, recvPrev + sentPrev);
    const msgDetail = recvPrev + sentPrev > 0
      ? ` (${msgArrow} from ${sentPrev}/${recvPrev})`
      : "";

    const stats = [
      "## Usage (last 7 days)",
      `Unique users: ${usersNow}${usersDetail}`,
      `Messages: sent ${sentNow} / received ${recvNow}${msgDetail}`,
    ].join("\n");

    usageStatsCache = { value: stats, expiresAt: Date.now() + USAGE_STATS_TTL_MS };
    return stats;
  } catch (error) {
    logger.error("Failed to fetch usage stats", { error: String(error) });
    return "";
  }
}

// ── Entity Summary Lookup ────────────────────────────────────────────────────

interface InterlocutorEntity {
  id: string;
  canonicalName: string;
  type: string;
  summary: string | null;
}

/**
 * Fetch the interlocutor's entity summary by Slack user ID.
 * Has no dependency on retrieved memories — safe to run in parallel.
 */
async function fetchInterlocutorEntity(
  userId: string,
): Promise<InterlocutorEntity | null> {
  try {
    const rows = await db
      .select({
        id: entities.id,
        canonicalName: entities.canonicalName,
        type: entities.type,
        summary: entities.summary,
      })
      .from(entities)
      .where(
        and(
          eq(entities.slackUserId, userId),
          isNotNull(entities.summary),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  } catch (error) {
    logger.error("Failed to fetch interlocutor entity", {
      error: String(error),
    });
    return null;
  }
}

/**
 * Build entity summaries from the pre-fetched interlocutor entity and
 * entities mentioned in retrieved memories.
 * Returns up to ~4 summaries: the interlocutor + top 3 related entities.
 */
async function buildEntitySummaries(
  userId: string,
  interlocutor: InterlocutorEntity | null,
  retrievedMemories: Memory[],
): Promise<EntitySummary[]> {
  try {
    const summaries: EntitySummary[] = [];
    const seenIds = new Set<string>();

    if (interlocutor?.summary) {
      summaries.push({
        name: interlocutor.canonicalName,
        type: interlocutor.type,
        summary: interlocutor.summary,
      });
      seenIds.add(interlocutor.id);
    }

    const relatedSlackIds = new Set<string>();
    for (const mem of retrievedMemories) {
      for (const uid of mem.relatedUserIds) {
        if (uid !== userId) relatedSlackIds.add(uid);
      }
    }

    if (relatedSlackIds.size > 0) {
      const relatedEntities = await db
        .select({
          id: entities.id,
          canonicalName: entities.canonicalName,
          type: entities.type,
          summary: entities.summary,
        })
        .from(entities)
        .where(
          and(
            inArray(entities.slackUserId, [...relatedSlackIds]),
            isNotNull(entities.summary),
          ),
        )
        .limit(10);

      for (const e of relatedEntities) {
        if (seenIds.has(e.id) || !e.summary) continue;
        if (summaries.length >= 4) break;
        summaries.push({
          name: e.canonicalName,
          type: e.type,
          summary: e.summary,
        });
        seenIds.add(e.id);
      }
    }

    return summaries;
  } catch (error) {
    logger.error("Failed to fetch entity summaries", {
      error: String(error),
    });
    return [];
  }
}

// ── Core Prompt ──────────────────────────────────────────────────────────────

export interface CorePrompt {
  stablePrefix: string;
  conversationContext: string;
  dynamicContext: string;
  memories: Memory[];
  conversations: ConversationThread[];
  userProfile: UserProfile | null;
  retrievedSkills: RetrievedSkill[];
}

/**
 * Build the full system prompt with memory retrieval, user profile, and
 * conversation context. Channel-agnostic — works for Slack, Dashboard, etc.
 *
 * Slack-specific enrichments (mention parsing, channel name resolution,
 * Slack List item context) are handled by the Slack connector after calling
 * this function.
 */
export async function buildCorePrompt(
  session: ChannelSession,
): Promise<CorePrompt> {
  const start = Date.now();

  let queryEmbedding: number[] | undefined;
  try {
    queryEmbedding = await embedText(session.messageText);
  } catch (error) {
    logger.error("Embedding failed, proceeding without memory context", {
      error: String(error),
    });
  }

  const participantIds = (session.participantUserIds ?? [])
    .filter((id) => id !== session.userId)
    .slice(0, 10);

  const threadKey = session.threadId ?? session.conversationId;
  const turnId =
    session.turnId ??
    `${session.channel}:${session.conversationId}:${threadKey}:${Date.now()}`;

  const [memories, conversations, userProfile, mentionedPeople, interlocutor, usageStats, interlocutorEntity, retrievedSkills] =
    await Promise.all([
      queryEmbedding
        ? retrieveMemories({
            query: session.messageText,
            queryEmbedding,
            currentUserId: session.userId,
            limit: 15,
          }).catch(() => [] as Memory[])
        : Promise.resolve([] as Memory[]),
      queryEmbedding
        ? retrieveConversations({
            query: session.messageText,
            queryEmbedding,
            threadLimit: 3,
            matchLimit: 15,
            minSimilarity: 0.35,
            excludeThreadTs: session.threadId,
          })
        : Promise.resolve([] as ConversationThread[]),
      session.userProfile !== undefined
        ? Promise.resolve(session.userProfile)
        : getProfile(session.userId),
      lookupMentionedPeople(participantIds),
      lookupPerson(session.userId),
      getUsageStats(),
      fetchInterlocutorEntity(session.userId),
      queryEmbedding
        ? retrieveSkillsForTurn({
            queryEmbedding,
            workspaceId: "default",
          })
        : Promise.resolve([] as RetrievedSkill[]),
    ]);

  if (retrievedSkills.length > 0) {
    await logSkillRetrievals({
      turnId,
      userId: session.userId,
      retrievedSkills,
      workspaceId: "default",
    }).catch((error) => {
      logger.warn("Failed to log skill retrievals", {
        error: String(error),
        turnId,
      });
    });
  }

  // Build entity summaries (related-entities lookup depends on retrieved memories)
  const entitySummaries = await buildEntitySummaries(session.userId, interlocutorEntity, memories);

  const channelContext = session.channel === "dashboard"
    ? "Dashboard chat"
    : session.isDirectMessage
      ? "DM"
      : (session.channelDisplayName ?? session.conversationId);

  const channelType = session.channelType ?? (session.channel === "dashboard" ? "dashboard" : session.isDirectMessage ? "dm" : "public_channel");

  const { stablePrefix, conversationContext } = await buildSystemPrompt({
    memories,
    conversations,
    userProfile,
    channelContext,
    channelType,
    threadContext: session.conversationContext,
    isChannelHistory: session.isChannelHistory ?? false,
    mentionedPeople,
    interlocutor: interlocutor ?? undefined,
    entitySummaries,
    retrievedSkills,
  });

  const modelId = session.modelIdOverride ?? await getMainModelId();

  let dynamicContext = buildDynamicContext({
    userTimezone: session.userTimezone ?? userProfile?.timezone ?? undefined,
    modelId,
    channelId: session.conversationId,
    threadTs: session.threadId,
    usageStats,
  });

  if (session.channel === "dashboard") {
    dynamicContext +=
      "\n\nYou are responding via the Aura Dashboard chat panel (not Slack). Keep responses concise and well-formatted with markdown.";
  }

  logger.debug(`Built core prompt in ${Date.now() - start}ms`, {
    channel: session.channel,
    memoryCount: memories.length,
    conversationCount: conversations.length,
    hasProfile: !!userProfile,
  });

  return {
    stablePrefix,
    conversationContext,
    dynamicContext,
    memories,
    conversations,
    userProfile,
    retrievedSkills,
  };
}

// ── People lookup (moved from prompt.ts, shared across channels) ─────────

export async function lookupPerson(
  slackUserId: string,
): Promise<PersonProfile | null> {
  try {
    const manager = alias(users, "manager");
    const rows = await db
      .select({
        slackUserId: users.slackUserId,
        displayName: users.displayName,
        gender: users.gender,
        preferredLanguage: users.preferredLanguage,
        jobTitle: users.jobTitle,
        managerName: manager.displayName,
        notes: users.notes,
      })
      .from(users)
      .leftJoin(manager, and(eq(users.managerId, manager.slackUserId), eq(users.workspaceId, manager.workspaceId)))
      .where(eq(users.slackUserId, slackUserId))
      .limit(1);

    const r = rows[0];
    if (!r || r.slackUserId === null) return null;
    return {
      slackUserId: r.slackUserId,
      displayName: r.displayName,
      gender: r.gender,
      preferredLanguage: r.preferredLanguage,
      jobTitle: r.jobTitle,
      managerName: r.managerName,
      notes: r.notes,
    };
  } catch (error) {
    logger.error("Failed to look up person", {
      error: String(error),
      slackUserId,
    });
    return null;
  }
}

export async function lookupMentionedPeople(
  slackUserIds: string[],
): Promise<PersonProfile[]> {
  if (slackUserIds.length === 0) return [];

  try {
    const manager = alias(users, "manager");
    const rows = await db
      .select({
        slackUserId: users.slackUserId,
        displayName: users.displayName,
        gender: users.gender,
        preferredLanguage: users.preferredLanguage,
        jobTitle: users.jobTitle,
        managerName: manager.displayName,
        notes: users.notes,
      })
      .from(users)
      .leftJoin(manager, and(eq(users.managerId, manager.slackUserId), eq(users.workspaceId, manager.workspaceId)))
      .where(inArray(users.slackUserId, slackUserIds));

    return rows
      .filter(
        (r): r is typeof r & { slackUserId: string } =>
          r.slackUserId !== null,
      )
      .map((r) => ({
        slackUserId: r.slackUserId,
        displayName: r.displayName,
        gender: r.gender,
        preferredLanguage: r.preferredLanguage,
        jobTitle: r.jobTitle,
        managerName: r.managerName,
        notes: r.notes,
      }));
  } catch (error) {
    logger.error("Failed to look up mentioned people", {
      error: String(error),
      slackUserIds,
    });
    return [];
  }
}
