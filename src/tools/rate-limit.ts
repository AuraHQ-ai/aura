import { logger } from "../lib/logger.js";

// ── Rate Limiter ─────────────────────────────────────────────────────────────
//
// Shared rate limiter for Slack API calls across all serverless instances.
//
// When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are configured,
// uses Upstash Redis sliding-window rate limiting — shared across all Vercel
// instances. Falls back to an in-memory FIFO queue for local development.
//
// Slack Tier 2/3 methods allow ~20-50 req/min. We use 30 req/60s as the
// shared limit (safe headroom below Slack's actual limits).

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

// ── Upstash Redis (shared across instances) ──────────────────────────────────

let upstashInitPromise: Promise<any | null> | null = null;

function getUpstashLimiter(): Promise<any | null> {
  // If env vars aren't configured, this is permanent — no need to cache or retry
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return Promise.resolve(null);
  }

  if (upstashInitPromise) return upstashInitPromise;

  const promise = initUpstashLimiter();
  upstashInitPromise = promise;

  // If init fails transiently (returns null despite env vars being present),
  // clear the cache so the next call retries initialization
  promise.then((result) => {
    if (result === null) {
      upstashInitPromise = null;
    }
  });

  return promise;
}

async function initUpstashLimiter(): Promise<any | null> {
  // Support both Vercel KV naming (KV_REST_API_URL/TOKEN) and standalone Upstash naming
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    logger.debug("Upstash/KV not configured — using in-memory rate limiter");
    return null;
  }

  try {
    const { Redis } = await import("@upstash/redis");
    const { Ratelimit } = await import("@upstash/ratelimit");

    const redis = new Redis({ url, token });

    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(MAX_REQUESTS_PER_WINDOW, "60 s"),
      prefix: "aura:slack-api",
      analytics: false,
    });

    logger.info("Upstash rate limiter initialized", {
      limit: MAX_REQUESTS_PER_WINDOW,
      window: "60s",
    });

    return limiter;
  } catch (err: any) {
    logger.warn("Failed to initialize Upstash rate limiter — falling back to in-memory", {
      error: err.message,
    });
    return null;
  }
}

async function throttleUpstash(limiter: any): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { success, remaining, reset } = await limiter.limit("global");

    if (success) {
      if (remaining <= 5) {
        logger.debug("Upstash rate limit: running low", { remaining, resetMs: reset });
      }
      return;
    }

    // Rate limited — wait until the window resets, then retry
    const waitMs = Math.max(reset - Date.now(), 100);
    logger.info(`Upstash rate limit hit — waiting ${waitMs}ms (attempt ${attempt})`, {
      remaining,
      resetMs: reset,
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

// ── In-Memory FIFO Fallback (local dev / Upstash not configured) ─────────────

const requestTimestamps: number[] = [];
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
      requestTimestamps.push(now);
      const resolve = waitQueue.shift()!;
      resolve();
    } else {
      const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 50;
      if (!drainScheduled) {
        drainScheduled = true;
        setTimeout(drainQueue, waitMs);
        logger.info(
          `In-memory rate limit queue: ${waitQueue.length} waiting, next slot in ${waitMs}ms`,
        );
      }
      break;
    }
  }
}

function throttleInMemory(): Promise<void> {
  const now = Date.now();

  // Prune old timestamps
  while (
    requestTimestamps.length > 0 &&
    requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS
  ) {
    requestTimestamps.shift();
  }

  // Fast path: slot available and no one queued ahead
  if (
    requestTimestamps.length < MAX_REQUESTS_PER_WINDOW &&
    waitQueue.length === 0
  ) {
    requestTimestamps.push(now);
    return Promise.resolve();
  }

  // Slow path: FIFO queue
  return new Promise<void>((resolve) => {
    waitQueue.push(resolve);
    if (!drainScheduled) {
      if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
        const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 50;
        drainScheduled = true;
        setTimeout(drainQueue, waitMs);
        logger.info(
          `In-memory rate limit queue: ${waitQueue.length} waiting, next slot in ${waitMs}ms`,
        );
      } else {
        drainQueue();
      }
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Rate-limit a Slack API call. Uses shared Upstash Redis when configured
 * (production), falls back to in-memory FIFO queue (local dev).
 *
 * Call `await throttle()` before every Slack API call.
 */
export async function throttle(): Promise<void> {
  try {
    const limiter = await getUpstashLimiter();
    if (limiter) {
      return await throttleUpstash(limiter);
    }
  } catch (err: any) {
    // Infrastructure failures (Redis down, network error) fall through to in-memory
    logger.warn("Upstash throttle failed — falling back to in-memory", {
      error: err.message,
    });
  }

  return throttleInMemory();
}
