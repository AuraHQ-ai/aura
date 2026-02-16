import { logger } from "../lib/logger.js";

// ── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * Simple token-bucket rate limiter for Slack API calls.
 * Slack's Tier 2/3 methods allow ~20-50 requests per minute.
 * We limit to 15 req/min with a burst of 5 to stay well under.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 15;
const requestTimestamps: number[] = [];

export async function throttle(): Promise<void> {
  const now = Date.now();

  // Prune timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    // Wait until the oldest request falls outside the window
    const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 50;
    logger.info(`Slack API throttle: waiting ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  requestTimestamps.push(Date.now());
}
