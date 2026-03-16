import { logger } from "./logger.js";
import type { ScheduleContext } from "@aura/db/schema";

/**
 * Resolve a user display name / username / Slack ID to a Slack user ID.
 * Tries: raw Slack ID → Slack API user list → DB userProfiles fallback.
 */
export async function resolveSlackUserId(
  userName: string,
): Promise<string | null> {
  const trimmed = userName.replace(/^@/, "").trim();

  if (/^U[A-Z0-9]{6,}$/.test(trimmed)) {
    return trimmed;
  }

  // Try Slack API first (fast, cached, has display names)
  if (process.env.SLACK_BOT_TOKEN) {
    try {
      const { WebClient } = await import("@slack/web-api");
      const { getUserList } = await import("../tools/slack.js");
      const client = new WebClient(process.env.SLACK_BOT_TOKEN);
      const users = await getUserList(client);

      const normalizedInput = trimmed.toLowerCase();

      for (const user of users) {
        if (
          user.displayName.toLowerCase() === normalizedInput ||
          user.realName.toLowerCase() === normalizedInput ||
          user.username.toLowerCase() === normalizedInput
        ) {
          return user.id;
        }
      }

      for (const user of users) {
        if (
          user.displayName.toLowerCase().startsWith(normalizedInput) ||
          user.realName.toLowerCase().startsWith(normalizedInput) ||
          user.username.toLowerCase().startsWith(normalizedInput)
        ) {
          return user.id;
        }
      }
    } catch (error: any) {
      logger.warn("Slack user list lookup failed, falling back to DB", {
        userName,
        error: error.message,
      });
    }
  }

  // Fallback: query userProfiles in DB (exact match first, then prefix)
  try {
    const { db } = await import("../db/client.js");
    const { userProfiles } = await import("@aura/db/schema");
    const { ilike } = await import("drizzle-orm");

    const [exact] = await db
      .select({ slackUserId: userProfiles.slackUserId })
      .from(userProfiles)
      .where(ilike(userProfiles.displayName, trimmed))
      .limit(1);
    if (exact) return exact.slackUserId;

    const { sql } = await import("drizzle-orm");
    const [prefix] = await db
      .select({ slackUserId: userProfiles.slackUserId })
      .from(userProfiles)
      .where(ilike(userProfiles.displayName, `${trimmed}%`))
      .orderBy(sql`${userProfiles.interactionCount} DESC NULLS LAST`)
      .limit(1);
    if (prefix) return prefix.slackUserId;
  } catch (error: any) {
    logger.error("DB user lookup fallback failed", {
      userName,
      error: error.message,
    });
  }

  return null;
}

export async function resolveEffectiveUserId(
  userName: string | undefined,
  context?: ScheduleContext,
): Promise<{ userId: string | undefined; error?: string }> {
  if (context?.userId && !userName) {
    return { userId: context.userId };
  }
  if (userName) {
    const slackId = await resolveSlackUserId(userName);
    if (!slackId) {
      return {
        userId: undefined,
        error: `Could not resolve Slack user '${userName}'. Make sure they exist in the workspace.`,
      };
    }
    return { userId: slackId };
  }
  return {
    userId: undefined,
    error:
      "No user context available. Unable to determine whose Google token to use.",
  };
}
