import { logger } from "./logger.js";

/**
 * Default cap on the serialized size of a tool result that reaches the model.
 * Applied by defineTool() unless a tool overrides it via `maxResultChars`
 * (a number) or opts out entirely (`false`). Uncapped tool output is a silent
 * cost bomb — one oversized result gets re-sent on every subsequent step of
 * the turn (see #1328/#1329).
 */
export const DEFAULT_MAX_RESULT_CHARS = 12000;

// In-memory per-process counter of cap firings by tool name. On serverless
// this only spans one invocation, so the count is also included in every
// warn log line — aggregate over logs to see which tools chronically overflow.
const capCounts = new Map<string, number>();

export function getToolResultCapCounts(): Record<string, number> {
  return Object.fromEntries(capCounts);
}

export function resetToolResultCapCounts(): void {
  capCounts.clear();
}

type CapStrategy =
  | "string"
  | "array-items"
  | "object-array-items"
  | "object-string-field"
  | "serialized-fallback";

function recordCap(
  toolName: string,
  strategy: CapStrategy,
  originalChars: number,
  maxChars: number,
): void {
  const count = (capCounts.get(toolName) ?? 0) + 1;
  capCounts.set(toolName, count);
  logger.warn("Tool result exceeded cap and was truncated", {
    toolName,
    strategy,
    originalChars,
    maxChars,
    capCount: count,
  });
}

/**
 * The explicit, model-visible truncation marker. Never truncate silently:
 * the model must be able to tell it received a partial result and react
 * (narrow the query, paginate, filter).
 */
function buildMarker(
  omittedChars: number,
  totalChars: number,
  items?: { shown: number; total: number },
): string {
  const itemsPart = items
    ? ` (showing ${items.shown} of ${items.total} items)`
    : "";
  return `... [truncated ${omittedChars} chars of ${totalChars}${itemsPart} — narrow the query or paginate]`;
}

/**
 * Truncate a string to at most maxChars INCLUDING the appended marker.
 */
function truncateStringWithMarker(value: string, maxChars: number): string {
  // First pass sizes the marker with upper-bound digits, second pass corrects
  // for digit-count drift so the output never exceeds maxChars.
  let keep = Math.max(0, maxChars - buildMarker(value.length, value.length).length);
  let out = value.slice(0, keep) + buildMarker(value.length - keep, value.length);
  if (out.length > maxChars) {
    keep = Math.max(0, keep - (out.length - maxChars));
    out = value.slice(0, keep) + buildMarker(value.length - keep, value.length);
  }
  return out;
}

/**
 * Binary payloads (base64 blobs) are exempt from the cap. They are consumed
 * by toModelOutput() and converted to native image/file content parts
 * (browser screenshots, Slack/Drive file downloads) or passed onward as
 * attachments (email) — truncating mid-base64 corrupts them, and their
 * model-visible cost is image/file tokens, not text chars.
 */
function isBinaryPayloadField(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (typeof value !== "string" || value.length < 512) return false;
  if (/base64/i.test(key)) return true;
  if (key === "content" && obj.encoding === "base64") return true;
  return false;
}

/** Reserve for the marker element / _note + _truncated fields when sizing. */
const MARKER_RESERVE = 200;

/**
 * Cap a tool result to at most maxChars of serialized text (binary payload
 * fields excluded, see isBinaryPayloadField). Degrades gracefully:
 *
 * 1. Arrays (top-level, or the dominant array field of an object) drop items
 *    from the end — mirroring bigquery.ts's row-halving — and carry an
 *    explicit marker. Never slices mid-JSON.
 * 2. Objects dominated by one large string field get that field truncated in
 *    place with a marker; the rest of the object stays intact.
 * 3. Otherwise the serialized JSON is truncated and wrapped in
 *    { _truncated: true, truncated_result: "..." } so the result is never
 *    malformed JSON pretending to be complete.
 */
export function capToolResult(
  result: unknown,
  maxChars: number,
  toolName: string,
): unknown {
  if (result == null || typeof result === "number" || typeof result === "boolean") {
    return result;
  }

  if (typeof result === "string") {
    if (result.length <= maxChars) return result;
    recordCap(toolName, "string", result.length, maxChars);
    return truncateStringWithMarker(result, maxChars);
  }

  if (typeof result !== "object") return result;

  // ── Top-level array: drop items from the end, append a marker element ──
  if (Array.isArray(result)) {
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch {
      return result; // circular / unserializable — leave to the SDK
    }
    if (serialized.length <= maxChars) return result;

    let items = result.slice();
    while (
      items.length > 0 &&
      JSON.stringify(items).length + MARKER_RESERVE > maxChars
    ) {
      items = items.slice(0, Math.floor(items.length / 2));
    }
    recordCap(toolName, "array-items", serialized.length, maxChars);
    const shownChars = JSON.stringify(items).length;
    return [
      ...items,
      buildMarker(serialized.length - shownChars, serialized.length, {
        shown: items.length,
        total: result.length,
      }),
    ];
  }

  // ── Plain object: set binary payload fields aside, cap the rest ──
  const obj = result as Record<string, unknown>;
  const binary: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isBinaryPayloadField(obj, k, v)) binary[k] = v;
    else rest[k] = v;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(rest);
  } catch {
    return result;
  }
  if (serialized.length <= maxChars) return result;

  const withBinary = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.keys(binary).length > 0 ? { ...o, ...binary } : o;

  // Strategy 1: dominant array field — halve items until the result fits.
  let arrayKey: string | null = null;
  let arrayFieldChars = 0;
  for (const [k, v] of Object.entries(rest)) {
    if (Array.isArray(v) && v.length > 0) {
      const len = JSON.stringify(v).length;
      if (len > arrayFieldChars) {
        arrayFieldChars = len;
        arrayKey = k;
      }
    }
  }
  if (arrayKey && serialized.length - arrayFieldChars + MARKER_RESERVE <= maxChars) {
    const allItems = rest[arrayKey] as unknown[];
    let items = allItems.slice();
    let candidate: Record<string, unknown>;
    do {
      items = items.slice(0, Math.floor(items.length / 2));
      candidate = {
        ...rest,
        [arrayKey]: items,
        _truncated: true,
        _note: buildMarker(
          serialized.length - JSON.stringify(items).length,
          serialized.length,
          { shown: items.length, total: allItems.length },
        ),
      };
    } while (JSON.stringify(candidate).length > maxChars && items.length > 0);
    recordCap(toolName, "object-array-items", serialized.length, maxChars);
    return withBinary(candidate);
  }

  // Strategy 2: dominant string field — truncate it in place, keep the rest.
  let strKey: string | null = null;
  let strLen = 0;
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === "string" && v.length > strLen) {
      strLen = v.length;
      strKey = k;
    }
  }
  if (strKey) {
    // overhead includes this field's JSON escaping, so truncating the raw
    // value to `room` chars can only shrink the final serialized size.
    const overhead = serialized.length - strLen;
    const room = maxChars - overhead - MARKER_RESERVE;
    if (room >= 64) {
      recordCap(toolName, "object-string-field", serialized.length, maxChars);
      return withBinary({
        ...rest,
        [strKey]: truncateStringWithMarker(rest[strKey] as string, room + MARKER_RESERVE - 24),
        _truncated: true,
      });
    }
  }

  // Fallback: truncate the serialized JSON inside a wrapper string so the
  // result itself is never malformed JSON. The embedded slice gains escape
  // characters when re-stringified, so measure and shrink until it fits.
  recordCap(toolName, "serialized-fallback", serialized.length, maxChars);
  let budget = Math.max(0, maxChars - 64);
  let wrapper: Record<string, unknown> = { _truncated: true, truncated_result: "" };
  for (let i = 0; i < 8; i++) {
    wrapper = {
      _truncated: true,
      truncated_result: truncateStringWithMarker(serialized, budget),
    };
    const overage = JSON.stringify(wrapper).length - maxChars;
    if (overage <= 0 || budget === 0) break;
    budget = Math.max(0, budget - overage);
  }
  return withBinary(wrapper);
}
