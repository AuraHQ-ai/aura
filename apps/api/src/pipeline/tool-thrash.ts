import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";

// ── Execution-side thrash breaker (issue #1524) ──────────────────────────────
// A degenerate model turn can PARSE and EXECUTE dozens of garbage tool calls
// (fake canvas ops, channel create, archive_emails, junk jobs). Failed calls
// used to bounce back to the model as tool_result errors, and the pipeline
// kept looping until the 720s hard deadline. This module is the execution
// abort: consecutive tool failures and a per-turn call cap both stop the
// turn immediately, with an error_event so leak/thrash rate is measurable
// per model.

/** Consecutive tool execution errors that abort the turn. */
export const DEFAULT_CONSECUTIVE_TOOL_ERROR_LIMIT = 5;

/** Tool calls allowed in one turn before the next call aborts it. */
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 40;

const RECENT_NAMES_MAX = 12;

export type ToolThrashReason = "consecutive_errors" | "max_tool_calls";

export interface ToolThrashLimits {
  consecutiveErrorLimit: number;
  maxToolCalls: number;
}

export interface ToolThrashSnapshot {
  callCount: number;
  consecutiveErrors: number;
}

export interface ToolThrashTrip {
  reason: ToolThrashReason;
  callCount: number;
  consecutiveErrors: number;
  lastToolName?: string;
  recentToolNames: string[];
  limits: ToolThrashLimits;
}

function readPositiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveToolThrashLimits(): ToolThrashLimits {
  return {
    consecutiveErrorLimit: readPositiveEnv(
      "TOOL_THRASH_CONSECUTIVE_ERROR_LIMIT",
      DEFAULT_CONSECUTIVE_TOOL_ERROR_LIMIT,
    ),
    maxToolCalls: readPositiveEnv(
      "TOOL_THRASH_MAX_TOOL_CALLS",
      DEFAULT_MAX_TOOL_CALLS_PER_TURN,
    ),
  };
}

export function isFailedToolOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const record = output as { ok?: unknown; error?: unknown };
  if (record.ok === false) return true;
  if (record.error) return true;
  return false;
}

export class ToolThrashError extends Error {
  constructor(public readonly trip: ToolThrashTrip) {
    super(formatToolThrashLogMessage(trip));
    this.name = "ToolThrashError";
  }
}

export function isToolThrashError(error: unknown): error is ToolThrashError {
  return (
    error instanceof ToolThrashError ||
    (error instanceof Error && error.name === "ToolThrashError")
  );
}

export function formatToolThrashUserMessage(trip: ToolThrashTrip): string {
  if (trip.reason === "consecutive_errors") {
    return (
      `I'm stopping this turn: ${trip.consecutiveErrors} tools in a row failed, ` +
      `so I won't keep retrying. Tell me what to try next.`
    );
  }
  return (
    `I'm stopping this turn: it already ran ${trip.callCount} tools without ` +
    `wrapping up. Tell me which part to continue.`
  );
}

export function formatToolThrashLogMessage(trip: ToolThrashTrip): string {
  if (trip.reason === "consecutive_errors") {
    return (
      `Turn aborted after ${trip.consecutiveErrors} consecutive tool execution ` +
      `errors (limit ${trip.limits.consecutiveErrorLimit})`
    );
  }
  return (
    `Turn aborted after ${trip.callCount} tool calls ` +
    `(cap ${trip.limits.maxToolCalls})`
  );
}

export class ToolThrashBreaker {
  readonly limits: ToolThrashLimits;
  private callCount = 0;
  private consecutiveErrors = 0;
  private tripped: ToolThrashTrip | null = null;
  private recentToolNames: string[] = [];

  constructor(
    limits: ToolThrashLimits = resolveToolThrashLimits(),
    snapshot?: ToolThrashSnapshot | null,
  ) {
    this.limits = limits;
    if (snapshot) {
      this.callCount = snapshot.callCount;
      this.consecutiveErrors = snapshot.consecutiveErrors;
    }
  }

  get trip(): ToolThrashTrip | null {
    return this.tripped;
  }

  snapshot(): ToolThrashSnapshot {
    return {
      callCount: this.callCount,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  recordCall(toolName: string): ToolThrashTrip | null {
    if (this.tripped) return this.tripped;
    this.callCount++;
    this.noteName(toolName);
    if (this.callCount > this.limits.maxToolCalls) {
      return this.ensureTrip("max_tool_calls", toolName);
    }
    return null;
  }

  recordResult(ok: boolean, toolName?: string): ToolThrashTrip | null {
    if (this.tripped) return this.tripped;
    if (ok) {
      this.consecutiveErrors = 0;
      return null;
    }
    this.consecutiveErrors++;
    if (toolName) this.noteName(toolName);
    if (this.consecutiveErrors >= this.limits.consecutiveErrorLimit) {
      return this.ensureTrip("consecutive_errors", toolName);
    }
    return null;
  }

  /**
   * After replaying completed steps: abort if the streak already meets the
   * error limit, or the call cap has already been exceeded. Exactly-at-cap
   * is allowed so the model can still emit a final text reply.
   */
  checkReplay(): ToolThrashTrip | null {
    if (this.tripped) return this.tripped;
    if (this.consecutiveErrors >= this.limits.consecutiveErrorLimit) {
      return this.ensureTrip("consecutive_errors");
    }
    if (this.callCount > this.limits.maxToolCalls) {
      return this.ensureTrip("max_tool_calls");
    }
    return null;
  }

  private noteName(toolName: string): void {
    if (!toolName) return;
    this.recentToolNames.push(toolName);
    if (this.recentToolNames.length > RECENT_NAMES_MAX) {
      this.recentToolNames.shift();
    }
  }

  private ensureTrip(reason: ToolThrashReason, lastToolName?: string): ToolThrashTrip {
    if (this.tripped) return this.tripped;
    this.tripped = {
      reason,
      callCount: this.callCount,
      consecutiveErrors: this.consecutiveErrors,
      ...(lastToolName ? { lastToolName } : {}),
      recentToolNames: [...this.recentToolNames],
      limits: this.limits,
    };
    return this.tripped;
  }
}

function namesFrom(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const names: string[] = [];
  for (const item of items) {
    const name = (item as { toolName?: unknown } | null)?.toolName;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

function resultsFrom(step: unknown): Array<{ toolName: string; ok: boolean }> {
  if (!step || typeof step !== "object") return [];
  const results = (step as { toolResults?: unknown }).toolResults;
  if (!Array.isArray(results)) return [];
  const out: Array<{ toolName: string; ok: boolean }> = [];
  for (const result of results) {
    const name = (result as { toolName?: unknown } | null)?.toolName;
    const toolName = typeof name === "string" && name ? name : "unknown";
    const output = (result as { output?: unknown } | null)?.output;
    out.push({ toolName, ok: !isFailedToolOutput(output) });
  }
  return out;
}

/**
 * Replay completed SDK steps into a breaker. Used by prepareStep so the
 * next model call never starts once the turn is already thrashing.
 */
export function detectToolThrashFromSteps(
  steps: Array<unknown> | null | undefined,
  limits: ToolThrashLimits = resolveToolThrashLimits(),
): ToolThrashTrip | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const breaker = new ToolThrashBreaker(limits);
  for (const step of steps) {
    const callNames = namesFrom((step as { toolCalls?: unknown } | null)?.toolCalls);
    const results = resultsFrom(step);
    if (callNames.length > 0) {
      for (const name of callNames) {
        const trip = breaker.recordCall(name);
        if (trip) return trip;
      }
      for (const result of results) {
        const trip = breaker.recordResult(result.ok, result.toolName);
        if (trip) return trip;
      }
      continue;
    }
    for (const result of results) {
      const callTrip = breaker.recordCall(result.toolName);
      if (callTrip) return callTrip;
      const resultTrip = breaker.recordResult(result.ok, result.toolName);
      if (resultTrip) return resultTrip;
    }
  }
  return breaker.checkReplay();
}

export function logToolThrashBreaker(params: {
  trip: ToolThrashTrip;
  modelId?: string;
  channelId?: string;
  userId?: string;
  path?: string;
  step?: number;
}): void {
  const { trip } = params;
  logger.warn("tool-thrash breaker tripped — aborting turn", {
    reason: trip.reason,
    callCount: trip.callCount,
    consecutiveErrors: trip.consecutiveErrors,
    lastToolName: trip.lastToolName,
    modelId: params.modelId,
    path: params.path,
    step: params.step,
  });
  logError({
    errorName: "ToolThrashBreaker",
    errorMessage: formatToolThrashLogMessage(trip),
    errorCode: "tool_thrash_breaker",
    channelId: params.channelId,
    userId: params.userId,
    context: {
      reason: trip.reason,
      callCount: trip.callCount,
      consecutiveErrors: trip.consecutiveErrors,
      lastToolName: trip.lastToolName,
      recentToolNames: trip.recentToolNames,
      consecutiveErrorLimit: trip.limits.consecutiveErrorLimit,
      maxToolCalls: trip.limits.maxToolCalls,
      modelId: params.modelId,
      path: params.path,
      step: params.step,
    },
  });
}
