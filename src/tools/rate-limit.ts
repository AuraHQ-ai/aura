import { logger } from "../lib/logger.js";

// ── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * Sliding-window rate limiter with FIFO queue for Slack API calls.
 * Slack Tier 2/3 methods allow ~20-50 req/min.
 * We use 20 req/60s as a safe default.
 *
 * The queue ensures that when multiple callers are waiting,
 * they execute in arrival order rather than racing.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const requestTimestamps: number[] = [];

// FIFO queue of resolvers waiting for a rate limit slot
const waitQueue: Array<() => void> = [];
let drainScheduled = false;

function drainQueue() {
  drainScheduled = false;

  while (waitQueue.length > 0) {
    const now = Date.now();

    // Prune old timestamps
    while (
      requestTimestamps.length > 0 &&
      requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS
    ) {
      requestTimestamps.shift();
    }

    if (requestTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
      // Slot available — let the next waiter through
      requestTimestamps.push(now);
      const resolve = waitQueue.shift()!;
      resolve();
    } else {
      // No slot — schedule retry when the oldest request expires
      const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 50;
      if (!drainScheduled) {
        drainScheduled = true;
        setTimeout(drainQueue, waitMs);
        logger.info(
          `Slack rate limit queue: ${waitQueue.length} waiting, next slot in ${waitMs}ms`,
        );
      }
      break;
    }
  }
}

export async function throttle(): Promise<void> {
  const now = Date.now();

  // Prune old timestamps
  while (
    requestTimestamps.length > 0 &&
    requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS
  ) {
    requestTimestamps.shift();
  }

  // Fast path: slot available and no one queued ahead of us
  if (
    requestTimestamps.length < MAX_REQUESTS_PER_WINDOW &&
    waitQueue.length === 0
  ) {
    requestTimestamps.push(now);
    return;
  }

  // Slow path: queue up and wait
  return new Promise<void>((resolve) => {
    waitQueue.push(resolve);
    if (!drainScheduled) {
      if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
        const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 50;
        drainScheduled = true;
        setTimeout(drainQueue, waitMs);
        logger.info(
          `Slack rate limit queue: ${waitQueue.length} waiting, next slot in ${waitMs}ms`,
        );
      } else {
        // There's capacity but someone is queued — drain immediately
        drainQueue();
      }
    }
  });
}
