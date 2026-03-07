import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { logger } from "./logger.js";

/**
 * Resolve the bot token for a Slack team.
 *
 * Priority:
 * 1. Active workspace record in the DB (multi-tenant OAuth install)
 * 2. Fallback to SLACK_BOT_TOKEN env var (legacy single-tenant)
 *
 * Returns null only if neither source provides a token.
 */
export async function getBotToken(
  teamId?: string,
): Promise<string | null> {
  if (teamId) {
    try {
      const [workspace] = await db
        .select({ botToken: workspaces.botToken })
        .from(workspaces)
        .where(
          and(eq(workspaces.teamId, teamId), eq(workspaces.isActive, true)),
        )
        .limit(1);

      if (workspace?.botToken) {
        return workspace.botToken;
      }
    } catch (err: any) {
      logger.warn("Failed to look up workspace token, falling back to env", {
        teamId,
        error: err.message,
      });
    }
  }

  return process.env.SLACK_BOT_TOKEN || null;
}

/**
 * Resolve the bot user ID for a Slack team.
 *
 * Priority:
 * 1. Active workspace record in the DB
 * 2. Fallback to AURA_BOT_USER_ID env var
 */
export async function getBotUserId(
  teamId?: string,
): Promise<string> {
  if (teamId) {
    try {
      const [workspace] = await db
        .select({ botUserId: workspaces.botUserId })
        .from(workspaces)
        .where(
          and(eq(workspaces.teamId, teamId), eq(workspaces.isActive, true)),
        )
        .limit(1);

      if (workspace?.botUserId) {
        return workspace.botUserId;
      }
    } catch (err: any) {
      logger.warn("Failed to look up workspace bot user ID, falling back to env", {
        teamId,
        error: err.message,
      });
    }
  }

  return process.env.AURA_BOT_USER_ID || "";
}

/**
 * Create a WebClient for a given team, resolving the token from DB or env.
 * Dynamically imports @slack/web-api to keep this module lightweight.
 */
export async function getSlackClientForTeam(
  teamId?: string,
): Promise<InstanceType<typeof import("@slack/web-api").WebClient> | null> {
  const token = await getBotToken(teamId);
  if (!token) return null;

  const { WebClient } = await import("@slack/web-api");
  return new WebClient(token);
}
