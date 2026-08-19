import { db } from "../db/client.js";
import { errorEvents } from "@aura/db/schema";
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

type RateLimitReason = "per_code" | "global";

const RATE_LIMIT_PER_CODE = 5;
const RATE_WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 20;
const SLACK_COOLDOWN_MS = 5 * 60_000;
const LOGGER_DROPS_FLUSH_MS = 60_000;
const LOGGER_DROPS_ERROR_CODE = "error_logger_drops";

const perCodeWindows = new Map<string, RateWindow>();
let globalWindow: RateWindow = { count: 0, windowStart: Date.now() };
let globalCircuitOpen = false;
const droppedByCode = new Map<string, { count: number; reasons: Record<RateLimitReason, number> }>();
let dropsFlushTimer: ReturnType<typeof setInterval> | null = null;
let flushingDrops = false;

const slackWindows = new Map<
  string,
  { lastPostTime: number; batchedCount: number }
>();

/**
 * Strip long numeric arrays from error messages.
 * Postgres "Failed query: ... params: ... [0.012, -0.034, ...]" dumps
 * full embedding vectors into error.message. Truncate them so #aura-errors
 * stays readable. Keep first 4 + last 2 values for debuggability.
 */
export function sanitizeErrorText(
  input: string | undefined | null,
  maxLen = 2000,
): string {
  if (!input) return "";

  // Match bracketed numeric arrays of >= 16 numeric items (signed floats incl. exp notation).
  // Regex is intentionally narrow to avoid stripping legitimate JSON arrays of strings.
  const NUM_ARRAY_RE =
    /\[(?:\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*,){15,}\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*\]/g;

  let out = input.replace(NUM_ARRAY_RE, (match) => {
    const nums = match
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim());
    const head = nums.slice(0, 4).join(",");
    const tail = nums.slice(-2).join(",");

    return `[${head},…(${nums.length} floats omitted)…,${tail}]`;
  });

  if (out.length > maxLen) {
    out = out.slice(0, maxLen) + `…(truncated, original ${input.length} chars)`;
  }

  return out;
}

function getRateLimit(errorCode: string): { limited: false } | { limited: true; reason: RateLimitReason } {
  const now = Date.now();

  // Global circuit breaker
  if (now - globalWindow.windowStart > RATE_WINDOW_MS) {
    globalWindow = { count: 0, windowStart: now };
    globalCircuitOpen = false;
  }
  if (globalCircuitOpen) return { limited: true, reason: "global" };
  if (globalWindow.count >= GLOBAL_LIMIT) {
    if (!globalCircuitOpen) {
      globalCircuitOpen = true;
      console.warn(
        "[error-logger] Global circuit breaker tripped — suppressing DB writes",
      );
    }
    return { limited: true, reason: "global" };
  }

  // Per-code rate limit
  const window = perCodeWindows.get(errorCode);
  if (!window || now - window.windowStart > RATE_WINDOW_MS) {
    perCodeWindows.set(errorCode, { count: 0, windowStart: now });
    return { limited: false };
  }
  if (window.count >= RATE_LIMIT_PER_CODE) {
    return { limited: true, reason: "per_code" };
  }
  return { limited: false };
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

function ensureDropsFlushTimer(): void {
  if (dropsFlushTimer) return;

  dropsFlushTimer = setInterval(() => {
    flushLoggerDrops().catch(() => {});
  }, LOGGER_DROPS_FLUSH_MS);
  (dropsFlushTimer as any).unref?.();
}

function recordDrop(errorCode: string, reason: RateLimitReason): void {
  if (flushingDrops) return;

  const existing = droppedByCode.get(errorCode) ?? {
    count: 0,
    reasons: { per_code: 0, global: 0 },
  };
  existing.count++;
  existing.reasons[reason]++;
  droppedByCode.set(errorCode, existing);
  ensureDropsFlushTimer();
}

export async function flushLoggerDrops(): Promise<void> {
  if (flushingDrops || droppedByCode.size === 0) return;

  flushingDrops = true;
  const drops = Object.fromEntries(
    Array.from(droppedByCode.entries()).map(([errorCode, value]) => [
      errorCode,
      {
        count: value.count,
        reasons: { ...value.reasons },
      },
    ]),
  );
  droppedByCode.clear();

  const totalDropped = Object.values(drops).reduce(
    (sum, value) => sum + value.count,
    0,
  );

  try {
    await db.insert(errorEvents)
      .values({
        errorName: "LoggerDrops",
        errorMessage: `Error logger dropped ${totalDropped} event${totalDropped === 1 ? "" : "s"} due to rate limiting`,
        errorCode: LOGGER_DROPS_ERROR_CODE,
        context: {
          drops,
          totalDropped,
          flushIntervalMs: LOGGER_DROPS_FLUSH_MS,
        },
      });
  } catch (err) {
    for (const [errorCode, value] of Object.entries(drops)) {
      const existing = droppedByCode.get(errorCode) ?? {
        count: 0,
        reasons: { per_code: 0, global: 0 },
      };
      existing.count += value.count;
      existing.reasons.per_code += value.reasons.per_code;
      existing.reasons.global += value.reasons.global;
      droppedByCode.set(errorCode, existing);
    }
    logger.warn("Failed to flush error logger drop counters", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    flushingDrops = false;
  }
}

export function resetErrorLoggerStateForTest(): void {
  perCodeWindows.clear();
  globalWindow = { count: 0, windowStart: Date.now() };
  globalCircuitOpen = false;
  droppedByCode.clear();
  flushingDrops = false;
  if (dropsFlushTimer) {
    clearInterval(dropsFlushTimer);
    dropsFlushTimer = null;
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

  let text = `*${params.errorName}*: ${sanitizeErrorText(params.errorMessage)}`;
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
  const rateLimit = getRateLimit(code);

  if (!rateLimit.limited) {
    recordWrite(code);

    db.insert(errorEvents)
      .values({
        errorName: params.errorName,
        errorMessage: sanitizeErrorText(params.errorMessage),
        errorCode: params.errorCode,
        userId: params.userId,
        channelId: params.channelId,
        channelType: params.channelType,
        context: params.context,
        stackTrace: sanitizeErrorText(params.stackTrace),
      })
      .catch(() => {});
  } else {
    recordDrop(code, rateLimit.reason);
  }

  if (!globalCircuitOpen) {
    postToSlack(params).catch(() => {});
  }
}
