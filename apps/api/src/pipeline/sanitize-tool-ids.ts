import type { ModelMessage } from "ai";

// ── Tool call id sanitization (issue #1376) ──────────────────────────────────
// A malformed or orphaned tool_use / tool_result id replayed from stored
// history kills the whole request at the provider:
//   messages.N.content.M.tool_use.id: String should match pattern
//   '^[a-zA-Z0-9_-]+$'
// This module is the guard at the message-assembly boundary (prepareStep runs
// it on every step, so replayed/reconstructed history is covered on every
// path: interactive Slack, headless jobs, dashboard workflow, continuations).

/** The provider-accepted tool_use id contract (Anthropic charset + length). */
export const TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const MAX_TOOL_CALL_ID_LENGTH = 64;

export interface SanitizeToolCallIdsResult {
  messages: Array<ModelMessage>;
  /** True when any id was rewritten or any block/message was dropped. */
  changed: boolean;
  /**
   * Raw → normalized id rewrites. The RAW ids are the whole point: issue
   * #1376 needs them logged so we learn the actual source of malformed ids
   * instead of guessing.
   */
  normalizedIds: Array<{ raw: string; sanitized: string }>;
  /** tool_result blocks dropped because no tool_use with that id precedes them. */
  droppedOrphanedToolResultIds: string[];
  /** tool_use blocks dropped because a completed turn has no matching tool_result. */
  droppedUnpairedToolCallIds: string[];
}

interface ToolPartRef {
  messageIndex: number;
  partIndex: number;
}

function isToolCallPart(part: unknown): part is { type: "tool-call"; toolCallId: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-call" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function isToolResultPart(part: unknown): part is { type: "tool-result"; toolCallId: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-result" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

/** Position ordering: earlier message wins; within a message, earlier part wins. */
function isBefore(a: ToolPartRef, b: ToolPartRef): boolean {
  return a.messageIndex < b.messageIndex ||
    (a.messageIndex === b.messageIndex && a.partIndex < b.partIndex);
}

/**
 * Normalize a raw id to the provider charset/length, uniquely against ids
 * already in use, so a rewritten tool_use keeps pairing with its rewritten
 * tool_result while never colliding with a legitimate id.
 */
function normalizeToolCallId(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_CALL_ID_LENGTH);
  if (base.length === 0) base = "tool_call";

  if (!taken.has(base)) return base;

  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate =
      base.slice(0, MAX_TOOL_CALL_ID_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Validate and repair tool_use / tool_result blocks before they are sent to
 * the provider (issue #1376):
 *
 * 1. Ids failing `^[a-zA-Z0-9_-]{1,64}$` are rewritten with a stable mapping
 *    so a tool_use and its matching tool_result stay paired.
 * 2. tool_result blocks with no preceding matching tool_use are dropped.
 * 3. tool_use blocks with no matching tool_result in a completed turn are
 *    dropped (the final message of the array is exempt — its results may not
 *    have been appended yet).
 * 4. Messages left with an empty content array are removed entirely.
 *
 * Pure transform: callers decide how to log the report. Returns the original
 * array untouched (same reference) when nothing needed fixing.
 */
export function sanitizeToolCallIds(
  messages: Array<ModelMessage>,
): SanitizeToolCallIdsResult {
  // ── Pass 1: collect ids and build the rename map ──────────────────────────
  const allRawIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isToolCallPart(part) || isToolResultPart(part)) {
        allRawIds.add(part.toolCallId);
      }
    }
  }

  const renameMap = new Map<string, string>();
  const taken = new Set<string>(
    [...allRawIds].filter((id) => TOOL_CALL_ID_PATTERN.test(id)),
  );
  for (const raw of allRawIds) {
    if (TOOL_CALL_ID_PATTERN.test(raw)) continue;
    const sanitized = normalizeToolCallId(raw, taken);
    taken.add(sanitized);
    renameMap.set(raw, sanitized);
  }

  const mapId = (raw: string): string => renameMap.get(raw) ?? raw;

  // ── Pass 2: index pairing positions (using mapped ids) ────────────────────
  const firstToolCallPosition = new Map<string, ToolPartRef>();
  const toolResultPositions = new Map<string, ToolPartRef[]>();
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    (message.content as unknown[]).forEach((part, partIndex) => {
      if (isToolCallPart(part)) {
        const id = mapId(part.toolCallId);
        if (!firstToolCallPosition.has(id)) {
          firstToolCallPosition.set(id, { messageIndex, partIndex });
        }
      } else if (isToolResultPart(part)) {
        const id = mapId(part.toolCallId);
        const positions = toolResultPositions.get(id) ?? [];
        positions.push({ messageIndex, partIndex });
        toolResultPositions.set(id, positions);
      }
    });
  });

  // ── Pass 3: rewrite ids, drop orphaned/unpaired blocks ────────────────────
  const normalizedIds: Array<{ raw: string; sanitized: string }> = [];
  const loggedRenames = new Set<string>();
  const droppedOrphanedToolResultIds: string[] = [];
  const droppedUnpairedToolCallIds: string[] = [];
  const lastMessageIndex = messages.length - 1;
  let changed = false;

  const result: Array<ModelMessage> = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      result.push(message);
      return;
    }

    let messageChanged = false;
    const newContent: unknown[] = [];
    (message.content as unknown[]).forEach((part, partIndex) => {
      const here: ToolPartRef = { messageIndex, partIndex };

      if (isToolCallPart(part)) {
        const id = mapId(part.toolCallId);
        const resultsAfter = (toolResultPositions.get(id) ?? []).some(
          (pos) => isBefore(here, pos),
        );
        // Only a COMPLETED turn requires pairing: the final message of the
        // array may legitimately still be waiting for its results.
        if (!resultsAfter && messageIndex !== lastMessageIndex) {
          droppedUnpairedToolCallIds.push(part.toolCallId);
          messageChanged = true;
          return;
        }
        if (id !== part.toolCallId) {
          if (!loggedRenames.has(part.toolCallId)) {
            loggedRenames.add(part.toolCallId);
            normalizedIds.push({ raw: part.toolCallId, sanitized: id });
          }
          newContent.push({ ...part, toolCallId: id });
          messageChanged = true;
          return;
        }
        newContent.push(part);
        return;
      }

      if (isToolResultPart(part)) {
        const id = mapId(part.toolCallId);
        const callBefore = firstToolCallPosition.get(id);
        if (!callBefore || !isBefore(callBefore, here)) {
          droppedOrphanedToolResultIds.push(part.toolCallId);
          messageChanged = true;
          return;
        }
        if (id !== part.toolCallId) {
          if (!loggedRenames.has(part.toolCallId)) {
            loggedRenames.add(part.toolCallId);
            normalizedIds.push({ raw: part.toolCallId, sanitized: id });
          }
          newContent.push({ ...part, toolCallId: id });
          messageChanged = true;
          return;
        }
        newContent.push(part);
        return;
      }

      newContent.push(part);
    });

    if (!messageChanged) {
      result.push(message);
      return;
    }

    changed = true;
    // A message whose content was emptied by the drops would itself be
    // rejected by the provider — remove it entirely.
    if (newContent.length === 0) return;
    result.push({ ...message, content: newContent } as ModelMessage);
  });

  if (!changed) {
    return {
      messages,
      changed: false,
      normalizedIds: [],
      droppedOrphanedToolResultIds: [],
      droppedUnpairedToolCallIds: [],
    };
  }

  return {
    messages: result,
    changed: true,
    normalizedIds,
    droppedOrphanedToolResultIds,
    droppedUnpairedToolCallIds,
  };
}
