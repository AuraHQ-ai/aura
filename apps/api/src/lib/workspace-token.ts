import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "@aura/db/schema";
import { logger } from "./logger.js";

/**
 * Resolve the bot token for a given Slack team.
 * Falls back to the SLACK_BOT_TOKEN env var when no team-specific token is found.
 */
export async function getBotToken(teamId?: string): Promise<string> {
  if (teamId) {
    try {
      const [workspace] = await db
        .select({ botToken: workspaces.botToken })
        .from(workspaces)
        .where(and(eq(workspaces.id, teamId), eq(workspaces.isActive, true)))
        .limit(1);

      if (workspace?.botToken) {
        return workspace.botToken;
      }
    } catch (error) {
      logger.warn("Failed to look up workspace bot token, falling back to env", {
        teamId,
        error: String(error),
      });
    }
  }

  return process.env.SLACK_BOT_TOKEN || "";
}

/**
 * Resolve the bot user ID for a given Slack team.
 * Falls back to the AURA_BOT_USER_ID env var when no team-specific value is found.
 */
export async function getBotUserId(teamId?: string): Promise<string> {
  if (teamId) {
    try {
      const [workspace] = await db
        .select({ botUserId: workspaces.botUserId })
        .from(workspaces)
        .where(and(eq(workspaces.id, teamId), eq(workspaces.isActive, true)))
        .limit(1);

      if (workspace?.botUserId) {
        return workspace.botUserId;
      }
    } catch (error) {
      logger.warn("Failed to look up workspace bot user ID, falling back to env", {
        teamId,
        error: String(error),
      });
    }
  }

  return process.env.AURA_BOT_USER_ID || "";
}
