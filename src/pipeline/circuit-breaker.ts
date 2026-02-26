/**
 * Circuit breaker for the agent loop — catches semantic repetition and
 * consecutive command failures that string-identical loop detection misses.
 *
 * Three mechanisms:
 * 1. Command normalization: strips comments, collapses whitespace so
 *    formatting-only differences don't evade the existing loop detector.
 * 2. Semantic key extraction: identifies the "intent" of a tool call
 *    (base command + target URL/host) so similar-but-not-identical calls
 *    are grouped together.
 * 3. Consecutive failure tracking: trips the circuit breaker after N
 *    consecutive failures with the same semantic key.
 */

import { logger } from "../lib/logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const CIRCUIT_BREAKER_THRESHOLD = 3;
const SEMANTIC_LOOP_WINDOW = 12;

export const CIRCUIT_BREAKER_MESSAGE =
  "CIRCUIT BREAKER: You've failed at this {count} times in a row. " +
  "The external service may be down, the command may be wrong, or " +
  "the approach isn't working. STOP retrying this command. " +
  "Either try a completely different approach or report the failure " +
  "to the user and move on.";

export const SEMANTIC_LOOP_MESSAGE =
  "WARNING: You've called the same tool with semantically similar inputs " +
  "{count} times (same command/endpoint pattern). This looks like a loop. " +
  "STOP and try a fundamentally different approach, or report the failure.";

// ── Command Normalization ────────────────────────────────────────────────────

/**
 * Find the index of a shell comment (#) that isn't inside a quoted string
 * or part of a URL fragment / shebang. Returns -1 if none found.
 */
function findShellCommentIndex(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Normalize a shell command string for comparison:
 * - Remove shell comments
 * - Collapse all whitespace to single spaces
 * - Trim each line
 * - Join multi-line commands
 */
export function normalizeCommand(cmd: string): string {
  return cmd
    .split("\n")
    .map((line) => {
      const commentIdx = findShellCommentIndex(line);
      return commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    })
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join(" ; ");
}

/**
 * Produce a normalized hash string for tool args.
 * For `run_command`, normalizes the command before hashing.
 * For other tools, falls back to plain JSON.stringify.
 */
export function normalizeToolArgs(toolName: string, args: unknown): string {
  if (toolName === "run_command" && args && typeof args === "object") {
    const { command, workdir } = args as {
      command?: string;
      workdir?: string;
    };
    if (command) {
      const normalized = normalizeCommand(command);
      return JSON.stringify({ command: normalized, workdir: workdir || undefined });
    }
  }

  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

// ── Semantic Key Extraction ──────────────────────────────────────────────────

const URL_PATTERN = /https?:\/\/[^\s'"<>]+/g;

/**
 * Extract hostnames from URLs in a string.
 */
function extractHostnames(text: string): string[] {
  const urls = text.match(URL_PATTERN) || [];
  const hostnames: string[] = [];
  for (const u of urls) {
    try {
      hostnames.push(new URL(u).hostname);
    } catch {
      hostnames.push(u);
    }
  }
  return [...new Set(hostnames)].sort();
}

/**
 * Extract the base command from a (possibly normalized) shell command.
 * Strips path prefix, env vars, sudo, etc.
 */
function extractBaseCommand(cmd: string): string {
  let cleaned = cmd
    .replace(/^[\w]+=\S+\s+/g, "") // strip leading env vars
    .replace(/^(sudo|nohup|exec|env)\s+/g, ""); // strip prefixes
  const first = cleaned.split(/\s/)[0] || "";
  return first.replace(/^.*\//, ""); // strip path
}

/**
 * Extract a semantic key that captures the "intent" of a tool call.
 *
 * For `run_command`: base command + target hostnames + key file paths.
 * For `execute_query`: "execute_query" (all queries grouped).
 * For others: just the tool name.
 */
export function extractSemanticKey(toolName: string, args: unknown): string {
  if (toolName === "run_command" && args && typeof args === "object") {
    const { command } = args as { command?: string };
    if (command) {
      const normalized = normalizeCommand(command);
      const baseCmd = extractBaseCommand(normalized);
      const hostnames = extractHostnames(normalized);
      const parts = [toolName, baseCmd];
      if (hostnames.length > 0) {
        parts.push(hostnames.join(","));
      }
      return parts.join(":");
    }
  }

  if (toolName === "read_url" && args && typeof args === "object") {
    const { url } = args as { url?: string };
    if (url) {
      const hostnames = extractHostnames(url);
      return `read_url:${hostnames.join(",")}`;
    }
  }

  return toolName;
}

// ── Failure Detection ────────────────────────────────────────────────────────

/**
 * Determine if a tool call result represents a failure.
 *
 * For `run_command`:
 * - `ok === false` (timeout, sandbox error)
 * - `exit_code !== 0` (non-zero exit, which still has ok: true)
 *
 * For other tools:
 * - `ok === false`
 */
export function isToolCallFailure(toolName: string, output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;

  if (o.ok === false) return true;

  if (toolName === "run_command") {
    if (typeof o.exit_code === "number" && o.exit_code !== 0) return true;
  }

  return false;
}

// ── Circuit Breaker Tracker ──────────────────────────────────────────────────

interface ToolCallOutcome {
  toolName: string;
  semanticKey: string;
  normalizedHash: string;
  failed: boolean;
}

export interface CircuitBreakerResult {
  tripped: boolean;
  message?: string;
}

/**
 * Stateful tracker for the circuit breaker pattern.
 * Maintains a sliding window of tool call outcomes and detects:
 * 1. Consecutive failures with the same semantic key → circuit breaker
 * 2. Semantic repetition (same key appearing too many times) → loop warning
 */
export class CircuitBreakerTracker {
  private outcomes: ToolCallOutcome[] = [];

  /**
   * Record a tool call outcome.
   */
  record(
    toolName: string,
    args: unknown,
    output: unknown,
  ): void {
    this.outcomes.push({
      toolName,
      semanticKey: extractSemanticKey(toolName, args),
      normalizedHash: normalizeToolArgs(toolName, args),
      failed: isToolCallFailure(toolName, output),
    });

    // Keep the window bounded
    while (this.outcomes.length > SEMANTIC_LOOP_WINDOW) {
      this.outcomes.shift();
    }
  }

  /**
   * Check if the circuit breaker should trip.
   * Returns a result with a message to inject if tripped.
   */
  check(): CircuitBreakerResult {
    if (this.outcomes.length < CIRCUIT_BREAKER_THRESHOLD) {
      return { tripped: false };
    }

    // 1. Check consecutive failures with the same semantic key
    const consecutiveFailure = this.checkConsecutiveFailures();
    if (consecutiveFailure.tripped) return consecutiveFailure;

    // 2. Check semantic repetition (same key appearing too often, regardless of success)
    const semanticLoop = this.checkSemanticRepetition();
    if (semanticLoop.tripped) return semanticLoop;

    return { tripped: false };
  }

  private checkConsecutiveFailures(): CircuitBreakerResult {
    const last = this.outcomes[this.outcomes.length - 1];
    if (!last.failed) return { tripped: false };

    let count = 0;
    for (let i = this.outcomes.length - 1; i >= 0; i--) {
      const o = this.outcomes[i];
      if (o.failed && o.semanticKey === last.semanticKey) {
        count++;
      } else {
        break;
      }
    }

    if (count >= CIRCUIT_BREAKER_THRESHOLD) {
      logger.warn("Circuit breaker tripped: consecutive failures", {
        semanticKey: last.semanticKey,
        count,
      });
      return {
        tripped: true,
        message: CIRCUIT_BREAKER_MESSAGE.replace("{count}", String(count)),
      };
    }

    return { tripped: false };
  }

  private checkSemanticRepetition(): CircuitBreakerResult {
    const keyCounts = new Map<string, number>();
    for (const o of this.outcomes) {
      keyCounts.set(o.semanticKey, (keyCounts.get(o.semanticKey) || 0) + 1);
    }

    // Find keys that appear suspiciously often (more than 2× threshold)
    // but only for tool-name-specific keys (not bare tool names like "search_slack")
    const suspiciousThreshold = CIRCUIT_BREAKER_THRESHOLD * 2;
    for (const [key, count] of keyCounts) {
      if (count >= suspiciousThreshold && key.includes(":")) {
        // Also check that the most recent call uses this key
        const last = this.outcomes[this.outcomes.length - 1];
        if (last.semanticKey === key) {
          logger.warn("Circuit breaker tripped: semantic repetition", {
            semanticKey: key,
            count,
          });
          return {
            tripped: true,
            message: SEMANTIC_LOOP_MESSAGE.replace("{count}", String(count)),
          };
        }
      }
    }

    return { tripped: false };
  }
}
