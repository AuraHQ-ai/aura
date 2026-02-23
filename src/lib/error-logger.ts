import { db } from "../db/client.js";
import { errorEvents } from "../db/schema.js";
import { logger } from "./logger.js";
import { safePostMessage } from "./slack-messaging.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LogErrorParams {
  errorName: string;
  errorMessage: string;
  errorCode?: string;
  userId?: string;
  channelId?: string;
  channelType?: string;
  context?: Record<string, unknown>;
  stackTrace?: string;
}

// ── Rate Limiting ────────────────────────────────────────────────────────────

interface RateWindow {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_PER_CODE = 5;
const RATE_WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 20;
const SLACK_COOLDOWN_MS = 5 * 60_000;

const perCodeWindows = new Map<string, RateWindow>();
let globalWindow: RateWindow = { count: 0, windowStart: Date.now() };
let globalCircuitOpen = false;

const slackWindows = new Map<
  string,
  { lastPostTime: number; batchedCount: number }
>();

function isRateLimited(errorCode: string): boolean {
  const now = Date.now();

  // Global circuit breaker
  if (now - globalWindow.windowStart > RATE_WINDOW_MS) {
    globalWindow = { count: 0, windowStart: now };
    globalCircuitOpen = false;
  }
  if (globalCircuitOpen) return true;
  if (globalWindow.count >= GLOBAL_LIMIT) {
    if (!globalCircuitOpen) {
      globalCircuitOpen = true;
      console.warn(
        "[error-logger] Global circuit breaker tripped — suppressing DB writes",
      );
    }
    return true;
  }

  // Per-code rate limit
  const window = perCodeWindows.get(errorCode);
  if (!window || now - window.windowStart > RATE_WINDOW_MS) {
    perCodeWindows.set(errorCode, { count: 0, windowStart: now });
    return false;
  }
  return window.count >= RATE_LIMIT_PER_CODE;
}

function recordWrite(errorCode: string): void {
  const now = Date.now();

  globalWindow.count++;

  const window = perCodeWindows.get(errorCode);
  if (window) {
    window.count++;
  } else {
    perCodeWindows.set(errorCode, { count: 1, windowStart: now });
  }
}

// ── Slack Posting ────────────────────────────────────────────────────────────

let cachedErrorsChannelId: string | null = null;

async function getSlackClient(): Promise<
  InstanceType<typeof import("@slack/web-api").WebClient> | null
> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  const { WebClient } = await import("@slack/web-api");
  return new WebClient(token);
}

async function getErrorsChannelId(
  slack: InstanceType<typeof import("@slack/web-api").WebClient>,
): Promise<string | null> {
  if (cachedErrorsChannelId) return cachedErrorsChannelId;

  try {
    const result = await slack.conversations.list({
      types: "public_channel",
      limit: 1000,
    });
    const channel = result.channels?.find((c) => c.name === "aura-errors");
    if (channel?.id) {
      cachedErrorsChannelId = channel.id;
      return channel.id;
    }
  } catch {
    // Fall through
  }

  try {
    const createResult = await slack.conversations.create({
      name: "aura-errors",
      is_private: false,
    });
    if (createResult.channel?.id) {
      cachedErrorsChannelId = createResult.channel.id;
      return createResult.channel.id;
    }
  } catch {
    // Channel may already exist but not found due to pagination
  }

  return null;
}

async function postToSlack(params: LogErrorParams): Promise<void> {
  const code = params.errorCode || params.errorName;
  const now = Date.now();
  const slackState = slackWindows.get(code);

  if (slackState && now - slackState.lastPostTime < SLACK_COOLDOWN_MS) {
    slackState.batchedCount++;
    return;
  }

  const slack = await getSlackClient();
  if (!slack) return;

  const channelId = await getErrorsChannelId(slack);
  if (!channelId) return;

  let text = `*${params.errorName}*: ${params.errorMessage}`;
  if (params.errorCode) text += `\n*Code*: \`${params.errorCode}\``;
  if (params.userId) text += `  |  *User*: \`${params.userId}\``;
  if (params.channelId) text += `  |  *Channel*: \`${params.channelId}\``;

  if (slackState && slackState.batchedCount > 0) {
    text += `\n_(\`${code}\` occurred ${slackState.batchedCount} more time${slackState.batchedCount === 1 ? "" : "s"} since last report)_`;
  }

  slackWindows.set(code, { lastPostTime: now, batchedCount: 0 });
  try {
    await safePostMessage(slack, { channel: channelId, text });
  } catch {
    logger.warn("Failed to post error to #aura-errors");
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire-and-forget error logger. Writes to DB + posts to #aura-errors Slack
 * channel with in-memory rate limiting. Never throws.
 */
export function logError(params: LogErrorParams): void {
  const code = params.errorCode || params.errorName;

  if (!isRateLimited(code)) {
    recordWrite(code);

    db.insert(errorEvents)
      .values({
        errorName: params.errorName,
        errorMessage: params.errorMessage,
        errorCode: params.errorCode,
        userId: params.userId,
        channelId: params.channelId,
        channelType: params.channelType,
        context: params.context,
        stackTrace: params.stackTrace,
      })
      .catch(() => {});
  }

  if (!globalCircuitOpen) {
    postToSlack(params).catch(() => {});
  }
}
