import type { ModelMessage } from "ai";

// ── Context compaction constants (issue #1328) ────────────────────────────────
// Applied universally — interactive AND headless turns. Long turns happen on
// both paths (the $77.89 baseline turn was an interactive DM), so the gate is
// the step count, never the execution mode.
export const COMPACTION_START_STEP = 20;
export const COMPACTION_KEEP_RECENT = 15;
export const COMPACTION_MAX_RESULT_LENGTH = 500;
const COMPACTION_TRUNCATE_LENGTH = 200;

export interface CompactionResult {
  messages: Array<ModelMessage>;
  compactedCount: number;
  estimatedTokensSaved: number;
}

function getOutputText(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (o.type === "text" || o.type === "error-text") return o.value as string;
  if (o.type === "json" || o.type === "error-json") {
    try {
      // JSON.stringify returns undefined (not null) for undefined/function/
      // symbol top-level values — coalesce so the caller's null guard holds.
      return JSON.stringify(o.value) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Context compaction (issue #1328): replaces old, large tool results with
 * truncated stubs so long multi-step turns stop replaying full tool output on
 * every step (quadratic input growth).
 *
 * This is deliberately NOT pruning (issue #499 / PR #501): every compacted
 * part keeps its `toolCallId` and `toolName`, and the message/part structure
 * is untouched — no tool-call is ever left without its matching tool-result
 * (Anthropic rejects orphaned pairs outright), and the model can still see
 * WHAT it already did, so it does not re-run identical searches.
 *
 * Only the in-flight message array is modified — the persisted conversation
 * trace in the DB remains complete.
 */
export function compactMessages(
  messages: Array<ModelMessage>,
  stepNumber: number,
): CompactionResult {
  if (stepNumber < COMPACTION_START_STEP) {
    return { messages, compactedCount: 0, estimatedTokensSaved: 0 };
  }

  const keepFromEnd = COMPACTION_KEEP_RECENT * 2;
  let compactedCount = 0;
  let charsSaved = 0;

  const result = messages.map((message, index) => {
    if (index >= messages.length - keepFromEnd) return message;
    if (message.role !== "tool") return message;

    const content = message.content;
    if (!Array.isArray(content)) return message;

    let modified = false;
    const newContent = content.map((part) => {
      if (part.type !== "tool-result") return part;

      const originalText = getOutputText(part.output);
      if (originalText === null) return part;
      if (originalText.length <= COMPACTION_MAX_RESULT_LENGTH) return part;

      const truncated = originalText.substring(0, COMPACTION_TRUNCATE_LENGTH);
      const compactedValue =
        `[Compacted] ${part.toolName}: ${truncated}... [Full result available in conversation trace]`;

      modified = true;
      compactedCount++;
      charsSaved += originalText.length - compactedValue.length;

      return {
        ...part,
        output: { type: "text" as const, value: compactedValue },
      };
    });

    if (!modified) return message;
    return { ...message, content: newContent } as ModelMessage;
  });

  return {
    messages: result,
    compactedCount,
    estimatedTokensSaved: Math.round(charsSaved / 4),
  };
}
