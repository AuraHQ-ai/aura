import { eq, sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  userProfiles,
  type UserProfile,
  type CommunicationStyle,
  type KnownFacts,
} from "../db/schema.js";
import { getFastModel } from "../lib/ai.js";
import { logger } from "../lib/logger.js";

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
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, slackUserId))
    .limit(1);

  if (existing.length > 0) {
    const profile = existing[0];
    if (timezone && !profile.timezone) {
      await db
        .update(userProfiles)
        .set({ timezone, updatedAt: new Date() })
        .where(eq(userProfiles.slackUserId, slackUserId));
      return { ...profile, timezone };
    }
    return profile;
  }

  // Create new profile (upsert to handle concurrent inserts)
  const result = await db
    .insert(userProfiles)
    .values({
      slackUserId,
      displayName,
      timezone,
    })
    .onConflictDoNothing({ target: userProfiles.slackUserId })
    .returning();

  if (result.length > 0) {
    logger.info("Created new user profile", { slackUserId, displayName });
    return result[0];
  }

  // Another concurrent request inserted first — fetch the existing row
  const [concurrentlyCreated] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, slackUserId))
    .limit(1);

  return concurrentlyCreated;
}

/**
 * Increment interaction count and update last interaction time.
 * Called after every exchange.
 */
export async function recordInteraction(slackUserId: string): Promise<void> {
  await db
    .update(userProfiles)
    .set({
      interactionCount: sql`${userProfiles.interactionCount} + 1`,
      lastInteractionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.slackUserId, slackUserId));
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
  newFacts: z
    .object({
      role: z.string().optional(),
      team: z.string().optional(),
      interests: z.array(z.string()).optional(),
      personalDetails: z.array(z.string()).optional(),
      preferences: z.array(z.string()).optional(),
    })
    .optional(),
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
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, slackUserId))
      .limit(1);

    if (!profile) return;

    // Only run a full profile update every 10 interactions
    if (profile.interactionCount % 10 !== 0) return;

    const existingFacts = profile.knownFacts || {};
    const existingStyle = profile.communicationStyle;

    const model = await getFastModel();

    const { output: object } = await generateText({
      model,
      output: Output.object({ schema: profileUpdateSchema }),
      system: `You are analyzing a user's communication style and extracting facts about them. Based on the conversation below and their existing profile, provide an updated assessment.

Existing communication style: ${JSON.stringify(existingStyle)}
Existing known facts: ${JSON.stringify(existingFacts)}

Analyze the user's message style:
- verbosity: are they brief (terse), moderate, or verbose?
- formality: casual, neutral, or formal?
- emojiUsage: none, light, or heavy?
- preferredFormat: do they seem to prefer prose, bullets, or mixed?

Also extract any new facts you can identify — role, team, interests, personal details, or preferences.
Only include new facts that are clearly stated or strongly implied. Don't speculate.`,
      prompt: `User message: ${userMessage}\n\nAura's response: ${assistantResponse}`,
    });

    if (!object) {
      logger.debug("Profile update failed: model output did not match schema");
      return;
    }

    // Merge new facts with existing
    const mergedFacts: KnownFacts = {
      ...existingFacts,
      ...(object.newFacts?.role ? { role: object.newFacts.role } : {}),
      ...(object.newFacts?.team ? { team: object.newFacts.team } : {}),
      interests: [
        ...new Set([
          ...(existingFacts.interests || []),
          ...(object.newFacts?.interests || []),
        ]),
      ],
      personalDetails: [
        ...new Set([
          ...(existingFacts.personalDetails || []),
          ...(object.newFacts?.personalDetails || []),
        ]),
      ],
      preferences: [
        ...new Set([
          ...(existingFacts.preferences || []),
          ...(object.newFacts?.preferences || []),
        ]),
      ],
    };

    await db
      .update(userProfiles)
      .set({
        communicationStyle: object.communicationStyle,
        knownFacts: mergedFacts,
        updatedAt: new Date(),
      })
      .where(eq(userProfiles.slackUserId, slackUserId));

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
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, slackUserId))
    .limit(1);

  return results[0] || null;
}
