import type { ModelMessage } from "ai";

// ── Context compaction constants (issue #1328) ────────────────────────────────
// Applied universally — interactive AND headless turns. Long turns happen on
// both paths (the $77.89 baseline turn was an interactive DM), so the gate is
// the step count, never the execution mode.
export const COMPACTION_START_STEP = 20;
export const COMPACTION_KEEP_RECENT = 15;
export const COMPACTION_MAX_RESULT_LENGTH = 500;
const COMPACTION_TRUNCATE_LENGTH = 200;

// ── Summarize-on-evict constants (issue #1330) ────────────────────────────────
// Results being evicted are no longer blindly truncated: above
// SUMMARIZE_ON_EVICT_MIN_CHARS a cheap/fast model compresses the result into a
// structured summary instead. Below that, a summary would not save enough
// tokens over the 200-char truncation stub to pay for the model call, so the
// original hard-truncation path is kept.
/** Minimum original size (chars) for a summarization call to save tokens. */
export const SUMMARIZE_ON_EVICT_MIN_CHARS = 4_000;
/**
 * Above this size the result is considered enormous: a summarization call
 * would itself be expensive (the whole result is the prompt), so we fall back
 * to hard truncation rather than paying to compress it.
 */
export const SUMMARIZE_ON_EVICT_MAX_CHARS = 150_000;
/** Model tier used for evict summaries — must stay on the cheap/fast tier. */
export const SUMMARIZE_ON_EVICT_MODEL_TIER = "fast" as const;
/** Output budget for a single evict summary. */
export const SUMMARIZE_ON_EVICT_MAX_OUTPUT_TOKENS = 500;

export interface CompactionResult {
  messages: Array<ModelMessage>;
  compactedCount: number;
  /** How many of the compacted results were replaced by an LLM summary. */
  summarizedCount: number;
  estimatedTokensSaved: number;
}

/** Compresses a large evicted tool result into a structured summary. */
export type SummarizeToolResultFn = (input: {
  toolName: string;
  text: string;
}) => Promise<string>;

export interface CompactionOptions {
  /**
   * When provided, eligible results (see SUMMARIZE_ON_EVICT_MIN/MAX_CHARS)
   * are summarized instead of truncated. When absent, or when a summary call
   * fails, hard truncation is the fallback.
   */
  summarize?: SummarizeToolResultFn;
  /**
   * Per-turn memo keyed by toolCallId. Compaction reruns on EVERY step past
   * the threshold against the un-mutated history, so without this cache the
   * same result would be re-summarized once per step.
   */
  summaryCache?: Map<string, string>;
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

function buildTruncatedStub(toolName: string, originalText: string): string {
  const truncated = originalText.substring(0, COMPACTION_TRUNCATE_LENGTH);
  return `[Compacted] ${toolName}: ${truncated}... [Full result available in conversation trace]`;
}

function buildSummaryStub(
  toolName: string,
  originalText: string,
  summary: string,
): string {
  const elided = originalText.length - summary.length;
  return (
    `[Summarized] ${toolName}: the following is an AI-generated summary of a ` +
    `${originalText.length}-char result (~${elided} chars elided). ` +
    `[Full result available in conversation trace]\n${summary}`
  );
}

/**
 * Default evict summarizer (issue #1330): compresses a large tool result on
 * the fast tier (SUMMARIZE_ON_EVICT_MODEL_TIER) into a structured summary
 * that preserves the SHAPE of the data — row counts, column names, key
 * values, errors — rather than an arbitrary prefix of it.
 */
export async function summarizeEvictedToolResult(input: {
  toolName: string;
  text: string;
}): Promise<string> {
  const [{ generateText }, { getFastModel }, { aiTelemetry }] = await Promise.all([
    import("ai"),
    import("../lib/ai.js"),
    import("../lib/langfuse.js"),
  ]);
  const model = await getFastModel();

  const { text } = await generateText({
    model,
    maxOutputTokens: SUMMARIZE_ON_EVICT_MAX_OUTPUT_TOKENS,
    temperature: 0,
    telemetry: aiTelemetry("evict-summary"),
    instructions:
      `Compress the following output of the "${input.toolName}" tool into a dense, structured summary. ` +
      "Preserve the SHAPE of the data, not a prefix of it: " +
      "row/item counts, column or field names, key values and aggregates, notable outliers, " +
      "and ALL errors or warnings verbatim. " +
      "For command output keep exit-relevant lines (errors, failures, final status). " +
      "Do not add commentary or preamble — output only the summary.",
    prompt: input.text,
  });

  const summary = text.trim();
  if (!summary) throw new Error("evict summary came back empty");
  return summary;
}

/**
 * Context compaction (issue #1328): replaces old, large tool results with
 * compact stubs so long multi-step turns stop replaying full tool output on
 * every step (quadratic input growth).
 *
 * Summarize-on-evict (issue #1330): results larger than
 * SUMMARIZE_ON_EVICT_MIN_CHARS are compressed by a fast-tier model into a
 * structured summary instead of being hard-truncated to 200 chars, so the
 * model keeps what the data SAYS rather than an arbitrary fragment of it.
 * Hard truncation remains the fallback when no summarizer is wired, when the
 * summarization call fails, when the result is enormous
 * (> SUMMARIZE_ON_EVICT_MAX_CHARS), or when summarizing would not actually
 * save tokens.
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
export async function compactMessages(
  messages: Array<ModelMessage>,
  stepNumber: number,
  options: CompactionOptions = {},
): Promise<CompactionResult> {
  if (stepNumber < COMPACTION_START_STEP) {
    return {
      messages,
      compactedCount: 0,
      summarizedCount: 0,
      estimatedTokensSaved: 0,
    };
  }

  const keepFromEnd = COMPACTION_KEEP_RECENT * 2;
  const summaryCache = options.summaryCache ?? new Map<string, string>();

  const isEvicted = (index: number, message: ModelMessage): boolean =>
    index < messages.length - keepFromEnd && message.role === "tool";

  // Pass 1: summarize eligible evicted results (concurrently, memoized by
  // toolCallId) so pass 2 can stay synchronous.
  if (options.summarize) {
    const pending: Array<Promise<void>> = [];
    messages.forEach((message, index) => {
      if (!isEvicted(index, message)) return;
      const content = message.content;
      if (!Array.isArray(content)) return;

      for (const part of content) {
        if (part.type !== "tool-result") continue;
        if (summaryCache.has(part.toolCallId)) continue;

        const originalText = getOutputText(part.output);
        if (originalText === null) continue;
        if (originalText.length < SUMMARIZE_ON_EVICT_MIN_CHARS) continue;
        if (originalText.length > SUMMARIZE_ON_EVICT_MAX_CHARS) continue;

        const { toolCallId, toolName } = part;
        pending.push(
          options
            .summarize!({ toolName, text: originalText })
            .then((summary) => {
              // Cost guard: a "summary" that is not meaningfully smaller than
              // the original saves nothing — fall back to truncation.
              if (
                summary.trim().length > 0 &&
                summary.length < originalText.length / 2
              ) {
                summaryCache.set(toolCallId, summary.trim());
              }
            })
            .catch(() => {
              // Summarization is best-effort: on failure the part silently
              // falls back to the hard-truncation stub in pass 2.
            }),
        );
      }
    });
    if (pending.length > 0) await Promise.all(pending);
  }

  let compactedCount = 0;
  let summarizedCount = 0;
  let charsSaved = 0;

  // Pass 2: replace evicted oversized results with summary or truncation stubs.
  const result = messages.map((message, index) => {
    if (!isEvicted(index, message)) return message;

    const content = message.content;
    if (!Array.isArray(content)) return message;

    let modified = false;
    const newContent = content.map((part) => {
      if (part.type !== "tool-result") return part;

      const originalText = getOutputText(part.output);
      if (originalText === null) return part;
      if (originalText.length <= COMPACTION_MAX_RESULT_LENGTH) return part;

      const summary = summaryCache.get(part.toolCallId);
      const compactedValue = summary
        ? buildSummaryStub(part.toolName, originalText, summary)
        : buildTruncatedStub(part.toolName, originalText);

      modified = true;
      compactedCount++;
      if (summary) summarizedCount++;
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
    summarizedCount,
    estimatedTokensSaved: Math.round(charsSaved / 4),
  };
}
