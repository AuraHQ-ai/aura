import { eq, sql } from "drizzle-orm";
import { generateObject, generateText, Output } from "ai";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  userProfiles,
  type UserProfile,
  type CommunicationStyle,
  type KnownFacts,
} from "@aura/db/schema";
import { getFastModel } from "../lib/ai.js";
import { logger } from "../lib/logger.js";
import { ensurePersonLinked } from "../lib/person-resolution.js";

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
      Object.assign(profile, { timezone });
    }
    if (!profile.personId) {
      try {
        const personId = await ensurePersonLinked(profile);
        return { ...profile, personId };
      } catch (error) {
        logger.error("Failed to link existing profile to person", {
          profileId: profile.id,
          error: String(error),
        });
      }
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
    const profile = result[0];
    logger.info("Created new user profile", { slackUserId, displayName });
    try {
      const personId = await ensurePersonLinked(profile);
      return { ...profile, personId };
    } catch (error) {
      logger.error("Failed to link profile to person", {
        profileId: profile.id,
        error: String(error),
      });
    }
    return profile;
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

// ── Profile Consolidation ─────────────────────────────────────────────────

const CAPS = {
  interests: 100,
  preferences: 100,
  personalDetails: 50,
} as const;

const consolidatedSchema = z.object({
  consolidated: z.array(z.string()).describe("Consolidated list of items"),
});

async function consolidateCategory(
  model: Awaited<ReturnType<typeof getFastModel>>,
  category: string,
  items: string[],
  cap: number,
): Promise<string[]> {
  const { object } = await generateObject({
    model,
    schema: consolidatedSchema,
    system: `You are consolidating a user profile's "${category}" list. Merge semantically similar items, remove noise and overly granular entries, and keep genuinely distinct items. Preserve the most important/recent items. Return at most ${cap} items.`,
    prompt: `Consolidate these ${items.length} items:\n\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}`,
  });

  return object.consolidated.slice(0, cap);
}

/**
 * Consolidate bloated user profiles by deduplicating and merging similar items
 * via LLM. Runs as part of the daily cron to keep profiles bounded.
 */
export async function consolidateProfiles(): Promise<{
  profilesProcessed: number;
  totalBefore: number;
  totalAfter: number;
}> {
  const profiles = await db
    .select()
    .from(userProfiles)
    .where(
      sql`(
        jsonb_array_length(COALESCE(${userProfiles.knownFacts}->'interests', '[]'::jsonb)) > ${CAPS.interests}
        OR jsonb_array_length(COALESCE(${userProfiles.knownFacts}->'preferences', '[]'::jsonb)) > ${CAPS.preferences}
        OR jsonb_array_length(COALESCE(${userProfiles.knownFacts}->'personalDetails', '[]'::jsonb)) > ${CAPS.personalDetails}
      )`,
    );

  if (profiles.length === 0) {
    logger.info("Profile consolidation: no profiles need consolidation");
    return { profilesProcessed: 0, totalBefore: 0, totalAfter: 0 };
  }

  logger.info(
    `Profile consolidation: ${profiles.length} profile(s) need consolidation`,
  );

  const model = await getFastModel();
  let totalBefore = 0;
  let totalAfter = 0;

  for (const profile of profiles) {
    const facts = profile.knownFacts || {};
    const interests = facts.interests || [];
    const preferences = facts.preferences || [];
    const personalDetails = facts.personalDetails || [];

    const beforeCount =
      interests.length + preferences.length + personalDetails.length;

    const consolidated: KnownFacts = { ...facts };

    try {
      totalBefore += beforeCount;
      if (interests.length > CAPS.interests) {
        consolidated.interests = await consolidateCategory(
          model,
          "interests",
          interests,
          CAPS.interests,
        );
      }

      if (preferences.length > CAPS.preferences) {
        consolidated.preferences = await consolidateCategory(
          model,
          "preferences",
          preferences,
          CAPS.preferences,
        );
      }

      if (personalDetails.length > CAPS.personalDetails) {
        consolidated.personalDetails = await consolidateCategory(
          model,
          "personalDetails",
          personalDetails,
          CAPS.personalDetails,
        );
      }

      const afterCount =
        (consolidated.interests?.length || 0) +
        (consolidated.preferences?.length || 0) +
        (consolidated.personalDetails?.length || 0);
      totalAfter += afterCount;

      await db
        .update(userProfiles)
        .set({
          knownFacts: consolidated,
          lastProfileConsolidation: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.id, profile.id));

      logger.info("Consolidated user profile", {
        slackUserId: profile.slackUserId,
        before: beforeCount,
        after: afterCount,
      });
    } catch (error) {
      logger.error("Failed to consolidate profile", {
        slackUserId: profile.slackUserId,
        error: String(error),
      });
    }
  }

  logger.info("Profile consolidation complete", {
    profilesProcessed: profiles.length,
    totalBefore,
    totalAfter,
  });

  return { profilesProcessed: profiles.length, totalBefore, totalAfter };
}
