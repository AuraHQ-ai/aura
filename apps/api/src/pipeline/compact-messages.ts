import type { ModelMessage } from "ai";

// ── Context compaction constants (headless mode only) ─────────────────────────
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
      return JSON.stringify(o.value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Manus-style context compaction: replaces old, large tool results with
 * truncated summaries to keep the context window manageable during long-running
 * headless job executions.
 *
 * Only the in-flight messages are modified — the persisted conversation trace
 * in the DB remains complete.
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
