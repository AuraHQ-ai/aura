/**
 * Lightweight observability metrics.
 *
 * In a production deployment, these would push to a metrics service
 * (Datadog, Prometheus, Vercel Analytics, etc.). For now, we log them
 * as structured JSON for easy querying in Vercel logs.
 */

import { logger } from "./logger.js";

interface PipelineMetrics {
  /** Total pipeline execution time (ms) */
  totalMs: number;
  /** LLM call time (ms) */
  llmMs?: number;
  /** Memory retrieval time (ms) */
  retrievalMs?: number;
  /** Number of memories retrieved */
  memoriesUsed: number;
  /** Token usage */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Anti-pattern modifications made */
  modifications: string[];
  /** Channel type */
  channelType: string;
  /** User ID (hashed in production) */
  userId: string;
  /** Whether this was a transparency command */
  isTransparencyCommand: boolean;
}

/**
 * Record pipeline execution metrics.
 */
export function recordPipelineMetrics(metrics: PipelineMetrics): void {
  logger.info("METRICS:pipeline", {
    ...metrics,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Record an error event for observability.
 */
export function recordError(
  component: string,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  logger.error(`ERROR:${component}`, {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...context,
    timestamp: new Date().toISOString(),
  });
}
