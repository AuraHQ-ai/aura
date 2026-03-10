import { eq, sql, and, like, or, arrayContains } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories, userProfiles, type Memory } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { embedText } from "../lib/embeddings.js";

/**
 * Transparency features (NFR-3).
 *
 * Users can ask:
 * - "What do you know about me?" → Returns a summary of stored memories and profile
 * - "Forget X" → Removes specific memories
 */

/**
 * Get everything Aura knows about a user — their profile and all memories
 * where they appear in relatedUserIds.
 */
export async function getKnowledgeAboutUser(
  slackUserId: string,
): Promise<{
  profile: {
    displayName: string;
    communicationStyle: unknown;
    knownFacts: unknown;
    interactionCount: number;
    lastInteractionAt: Date | null;
  } | null;
  memories: { content: string; type: string; createdAt: Date }[];
  totalMemories: number;
}> {
  // Get profile
  const [profile] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, slackUserId))
    .limit(1);

  // Get all memories related to this user
  const userMemories = await db
    .select({
      content: memories.content,
      type: memories.type,
      createdAt: memories.createdAt,
      relevanceScore: memories.relevanceScore,
    })
    .from(memories)
    .where(
      sql`${slackUserId} = ANY(${memories.relatedUserIds})`,
    )
    .orderBy(sql`${memories.relevanceScore} DESC`)
    .limit(50);

  return {
    profile: profile
      ? {
          displayName: profile.displayName,
          communicationStyle: profile.communicationStyle,
          knownFacts: profile.knownFacts,
          interactionCount: profile.interactionCount,
          lastInteractionAt: profile.lastInteractionAt,
        }
      : null,
    memories: userMemories.map((m) => ({
      content: m.content,
      type: m.type,
      createdAt: m.createdAt,
    })),
    totalMemories: userMemories.length,
  };
}

/**
 * Format knowledge for display in Slack.
 */
export function formatKnowledgeSummary(
  knowledge: Awaited<ReturnType<typeof getKnowledgeAboutUser>>,
): string {
  const parts: string[] = [];

  parts.push("Here's what I know about you:\n");

  if (knowledge.profile) {
    const p = knowledge.profile;
    parts.push(`*Profile*`);
    parts.push(`Name: ${p.displayName}`);
    parts.push(`We've talked ${p.interactionCount} times.`);

    const facts = p.knownFacts as any;
    if (facts) {
      if (facts.role) parts.push(`Role: ${facts.role}`);
      if (facts.team) parts.push(`Team: ${facts.team}`);
      if (facts.interests?.length) parts.push(`Interests: ${facts.interests.join(", ")}`);
      if (facts.personalDetails?.length) {
        parts.push(`Personal notes: ${facts.personalDetails.join("; ")}`);
      }
      if (facts.preferences?.length) {
        parts.push(`Preferences: ${facts.preferences.join("; ")}`);
      }
    }

    const style = p.communicationStyle as any;
    if (style) {
      parts.push(
        `\nI've picked up that your communication style is ${style.verbosity}, ${style.formality}, with ${style.emojiUsage} emoji usage. You seem to prefer ${style.preferredFormat} format.`,
      );
    }
  }

  if (knowledge.memories.length > 0) {
    parts.push(`\n*Things I remember* (${knowledge.totalMemories} total):\n`);

    // Group by type
    const grouped: Record<string, string[]> = {};
    for (const m of knowledge.memories) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type].push(m.content);
    }

    const typeLabels: Record<string, string> = {
      fact: "Facts",
      decision: "Decisions",
      personal: "Personal",
      relationship: "Relationships",
      sentiment: "Impressions",
      open_thread: "Open threads",
    };

    for (const [type, items] of Object.entries(grouped)) {
      parts.push(`_${typeLabels[type] || type}_:`);
      for (const item of items.slice(0, 10)) {
        parts.push(`  - ${item}`);
      }
      if (items.length > 10) {
        parts.push(`  _(and ${items.length - 10} more)_`);
      }
    }
  } else {
    parts.push(
      "\nI don't have any specific memories about you yet — we're just getting started.",
    );
  }

  parts.push(
    '\nIf you want me to forget something specific, just say "forget [topic]" and I\'ll remove it.',
  );

  return parts.join("\n");
}

/**
 * Forget memories matching a user's request.
 * Uses semantic search to find relevant memories, then removes them.
 */
export async function forgetMemories(
  slackUserId: string,
  whatToForget: string,
): Promise<{
  forgottenCount: number;
  examples: string[];
}> {
  try {
    // Embed the "what to forget" query
    const queryEmbedding = await embedText(whatToForget);

    // Find semantically similar memories that belong to this user
    const similar = await db
      .select({
        id: memories.id,
        content: memories.content,
        similarity:
          sql<number>`1 - (${memories.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector)`.as(
            "similarity",
          ),
      })
      .from(memories)
      .where(
        and(
          sql`${slackUserId} = ANY(${memories.relatedUserIds})`,
          sql`${memories.embedding} IS NOT NULL`,
        ),
      )
      .orderBy(
        sql`${memories.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`,
      )
      .limit(10);

    // Only delete memories with high similarity (> 0.7)
    const toDelete = similar.filter((m) => m.similarity > 0.7);

    if (toDelete.length === 0) {
      return { forgottenCount: 0, examples: [] };
    }

    // Delete the matching memories
    const deleteIds = toDelete.map((m) => m.id);
    await db
      .delete(memories)
      .where(
        sql`${memories.id} IN (${sql.join(
          deleteIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      );

    logger.info("Forgot memories", {
      userId: slackUserId,
      count: toDelete.length,
      query: whatToForget,
    });

    return {
      forgottenCount: toDelete.length,
      examples: toDelete.slice(0, 3).map((m) => m.content),
    };
  } catch (error) {
    logger.error("Failed to forget memories", {
      error: String(error),
      userId: slackUserId,
    });
    throw error;
  }
}
