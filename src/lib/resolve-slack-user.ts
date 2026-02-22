import { logger } from "./logger.js";

/**
 * Resolve a user display name / username to a Slack user ID.
 * Reuses the paginated, cached getUserList from slack.ts.
 */
export async function resolveSlackUserId(
  userName: string,
): Promise<string | null> {
  try {
    const { WebClient } = await import("@slack/web-api");
    const { getUserList } = await import("../tools/slack.js");
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const users = await getUserList(client);

    const normalizedInput = userName
      .replace(/^@/, "")
      .toLowerCase()
      .trim();

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

    return null;
  } catch (error: any) {
    logger.error("Failed to resolve Slack user ID", {
      userName,
      error: error.message,
    });
    return null;
  }
}
