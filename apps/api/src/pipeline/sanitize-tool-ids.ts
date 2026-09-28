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

function isToolCallPart(
  part: unknown,
): part is { type: "tool-call"; toolCallId: string; providerExecuted?: boolean } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-call" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function isProviderExecutedToolCall(
  part: { providerExecuted?: boolean },
): boolean {
  return part.providerExecuted === true;
}

/** Providers that reject assistant prefill require the tail to be user/tool. */
function isAssistantPrefillTail(
  tailRole: ModelMessage["role"] | undefined,
  originalTailRole: ModelMessage["role"] | undefined,
): boolean {
  return tailRole === "assistant" && originalTailRole !== "assistant";
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
 *    have been appended yet). Provider-executed calls (`providerExecuted: true`,
 *    e.g. Bedrock `srvtoolu_bdrk_*`) are never dropped as unpaired — the
 *    provider owns their lifecycle, so pairing can legitimately straddle a
 *    compaction/eviction boundary (issue #1402).
 * 4. Messages left with an empty content array are removed entirely, unless
 *    doing so would leave the conversation ending on an assistant message
 *    when the original did not (illegal provider prefill, issue #1402).
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
    // Defer committing drops until we know whether this message is kept
    // intact to preserve the conversation's terminal role (issue #1402).
    const unpairedDropsThisMessage: string[] = [];
    const orphanDropsThisMessage: string[] = [];
    (message.content as unknown[]).forEach((part, partIndex) => {
      const here: ToolPartRef = { messageIndex, partIndex };

      if (isToolCallPart(part)) {
        const id = mapId(part.toolCallId);
        const resultsAfter = (toolResultPositions.get(id) ?? []).some(
          (pos) => isBefore(here, pos),
        );
        // Only a COMPLETED turn requires pairing: the final message of the
        // array may legitimately still be waiting for its results.
        // Provider-executed calls are owned by the provider (Bedrock
        // srvtoolu_bdrk_* etc.) — never classify them as unpaired.
        if (
          !isProviderExecutedToolCall(part) &&
          !resultsAfter &&
          messageIndex !== lastMessageIndex
        ) {
          unpairedDropsThisMessage.push(part.toolCallId);
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
          orphanDropsThisMessage.push(part.toolCallId);
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

    const commitDrops = (): void => {
      droppedUnpairedToolCallIds.push(...unpairedDropsThisMessage);
      droppedOrphanedToolResultIds.push(...orphanDropsThisMessage);
    };

    // A message whose content was emptied by the drops would itself be
    // rejected by the provider — remove it entirely, unless that would
    // change the terminal role into an illegal assistant prefill.
    if (newContent.length === 0) {
      const originalTailRole = messages[lastMessageIndex]?.role;
      const later = messages.slice(messageIndex + 1);
      const laterHasNonAssistant = later.some((m) => m.role !== "assistant");

      // A later user/tool message will still be appended, so dropping
      // this emptied message cannot produce an assistant-prefill tail.
      if (laterHasNonAssistant) {
        changed = true;
        commitDrops();
        return;
      }

      const projectedTailRole = later.length > 0
        ? later[later.length - 1]!.role
        : result.at(-1)?.role;

      // Discarding would leave the array ending on assistant where the
      // original ended on user/tool. Empty content is also rejected —
      // keep the original message instead of dropping it.
      if (isAssistantPrefillTail(projectedTailRole, originalTailRole)) {
        result.push(message);
        return;
      }

      // Near-tail assistant emptied of unpaired tool-calls, with the
      // original array already ending on assistant: dropping it leaves
      // a prefill-shaped tail (the trailing assistant). Keep original
      // content. Emptied tool/user messages in the same position still
      // discard (see "drops the whole message when every part was a
      // dropped orphan").
      if (
        message.role === "assistant" &&
        originalTailRole === "assistant" &&
        messageIndex !== lastMessageIndex
      ) {
        result.push(message);
        return;
      }

      changed = true;
      commitDrops();
      return;
    }

    changed = true;
    commitDrops();
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

  // Post-condition (issue #1402): never return an assistant-prefill tail
  // when the input did not end on assistant. Re-append the original
  // trailing user/tool message if drops produced that shape.
  const originalTail = messages[lastMessageIndex];
  if (
    originalTail &&
    isAssistantPrefillTail(result.at(-1)?.role, originalTail.role)
  ) {
    result.push(originalTail);
  }

  return {
    messages: result,
    changed: true,
    normalizedIds,
    droppedOrphanedToolResultIds,
    droppedUnpairedToolCallIds,
  };
}
