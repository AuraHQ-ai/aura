import { eq, sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  users,
  type UserProfile,
  type CommunicationStyle,
} from "@aura/db/schema";
import { getFastModel } from "../lib/ai.js";
import { logger } from "../lib/logger.js";
import { ensureSlackUserEntityLink } from "./entity-link.js";

/**
 * Get or create a user profile.
 */
export async function getOrCreateProfile(
  slackUserId: string,
  displayName: string,
  timezone?: string,
): Promise<UserProfile> {
  // Try to find existing
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.slackUserId, slackUserId))
    .limit(1);

  if (existing.length > 0) {
    const profile = existing[0];
    if (timezone && !profile.timezone) {
      await db
        .update(users)
        .set({ timezone, updatedAt: new Date() })
        .where(eq(users.slackUserId, slackUserId));
      Object.assign(profile, { timezone });
    }
    try {
      await ensureSlackUserEntityLink({
        userId: profile.id,
        slackUserId,
        displayName,
        workspaceId: profile.workspaceId ?? "default",
      });
    } catch (error) {
      logger.warn("Failed to ensure entity link for existing user", {
        slackUserId,
        error: String(error),
      });
    }
    return profile;
  }

  // Create new profile (upsert to handle concurrent inserts)
  const result = await db
    .insert(users)
    .values({
      slackUserId,
      displayName,
      timezone,
    })
    .onConflictDoNothing({ target: [users.workspaceId, users.slackUserId] })
    .returning();

  if (result.length > 0) {
    const profile = result[0];
    try {
      await ensureSlackUserEntityLink({
        userId: profile.id,
        slackUserId,
        displayName,
        workspaceId: profile.workspaceId ?? "default",
      });
    } catch (error) {
      logger.warn("Failed to ensure entity link for new user", {
        slackUserId,
        error: String(error),
      });
    }
    logger.info("Created new user profile", { slackUserId, displayName });
    return profile;
  }

  // Another concurrent request inserted first — fetch the existing row
  const [concurrentlyCreated] = await db
    .select()
    .from(users)
    .where(eq(users.slackUserId, slackUserId))
    .limit(1);

  if (concurrentlyCreated) {
    try {
      await ensureSlackUserEntityLink({
        userId: concurrentlyCreated.id,
        slackUserId,
        displayName,
        workspaceId: concurrentlyCreated.workspaceId ?? "default",
      });
    } catch (error) {
      logger.warn("Failed to ensure entity link for concurrent user", {
        slackUserId,
        error: String(error),
      });
    }
  }

  return concurrentlyCreated;
}

/**
 * Increment interaction count and update last interaction time.
 * Called after every exchange.
 */
export async function recordInteraction(slackUserId: string): Promise<void> {
  await db
    .update(users)
    .set({
      interactionCount: sql`${users.interactionCount} + 1`,
      lastInteractionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.slackUserId, slackUserId));
}

/**
 * Schema for LLM-generated profile updates.
 */
const profileUpdateSchema = z.object({
  communicationStyle: z.object({
    verbosity: z.enum(["terse", "moderate", "verbose"]),
    formality: z.enum(["casual", "neutral", "formal"]),
    emojiUsage: z.enum(["none", "light", "heavy"]),
    preferredFormat: z.enum(["prose", "bullets", "mixed"]),
  }),
});

/**
 * Update a user's profile based on recent conversation.
 * Runs every N interactions (e.g., every 10) via waitUntil.
 */
export async function updateProfileFromConversation(
  slackUserId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  try {
    // Get current profile
    const [profile] = await db
      .select()
      .from(users)
      .where(eq(users.slackUserId, slackUserId))
      .limit(1);

    if (!profile) return;

    // Only run a full profile update every 10 interactions
    if (profile.interactionCount % 10 !== 0) return;

    const existingStyle = profile.communicationStyle;

    const model = await getFastModel();

    const { output: object } = await generateText({
      model,
      output: Output.object({ schema: profileUpdateSchema }),
      system: `You are analyzing a user's communication style. Based on the conversation below and their existing profile, provide an updated assessment.

Existing communication style: ${JSON.stringify(existingStyle)}
Analyze the user's message style:
- verbosity: are they brief (terse), moderate, or verbose?
- formality: casual, neutral, or formal?
- emojiUsage: none, light, or heavy?
- preferredFormat: do they seem to prefer prose, bullets, or mixed?
Only update communication style. Do not extract or infer profile facts.`,
      prompt: `User message: ${userMessage}\n\nAura's response: ${assistantResponse}`,
    });

    if (!object) {
      logger.debug("Profile update failed: model output did not match schema");
      return;
    }

    await db
      .update(users)
      .set({
        communicationStyle: object.communicationStyle,
        updatedAt: new Date(),
      })
      .where(eq(users.slackUserId, slackUserId));

    logger.info("Updated user profile", {
      slackUserId,
      style: object.communicationStyle,
    });
  } catch (error) {
    logger.error("Failed to update user profile", {
      error: String(error),
      slackUserId,
    });
    // Non-fatal — don't crash the pipeline
  }
}

/**
 * Get a user profile by Slack user ID.
 */
export async function getProfile(
  slackUserId: string,
): Promise<UserProfile | null> {
  const results = await db
    .select()
    .from(users)
    .where(eq(users.slackUserId, slackUserId))
    .limit(1);

  return results[0] || null;
}

// ── Profile Consolidation (deprecated known_facts path) ──────────────────────

/**
 * Deprecated no-op retained for cron compatibility during known_facts sunset.
 * We intentionally stop writing users.known_facts while leaving existing data in place.
 */
export async function consolidateProfiles(): Promise<{
  profilesProcessed: number;
  totalBefore: number;
  totalAfter: number;
}> {
  logger.info("Profile consolidation skipped: users.known_facts is deprecated");
  return { profilesProcessed: 0, totalBefore: 0, totalAfter: 0 };
}
