/**
 * Eval funnel (Machine A) types.
 *
 * Machine A reads (nearly) every interaction, asks "was the user's intent
 * fulfilled?", and emits an atomic verdict per assistant response. It *finds*
 * failures at scale; the curated regression bench (#1106) *gates* PRs by
 * pulling ratified `failed` rows from here.
 *
 * Three grains — never conflate them:
 *   - SCORING grain     = message_id / part_id (the atomic response judged)
 *   - ATTRIBUTION grain = trace_id (joins to user/channel/model/cost only)
 *   - FILTER grain      = thread_ts (UI grouping; no FK; owns no verdict)
 */

import { z } from "zod";

/** Corpus start — "the beginning of time" for the walk and the backfill. */
export const EVAL_CORPUS_START =
  process.env.EVAL_CORPUS_START ?? "2026-03-12T00:00:00Z";

/**
 * One turn in the chronological thread sequence fed to the judge. A turn maps
 * to ONE `conversation_messages` row (across all traces of a thread, in order).
 * Tool-relay assistant steps with no user-facing text are context only — they
 * are never scoring candidates.
 */
export interface ConversationTurn {
  /** conversation_messages.id */
  messageId: string;
  /** "user" | "assistant" | "system" (system turns are dropped before windowing) */
  role: string;
  /** The assistant text part id, if this turn has user-facing text. */
  textPartId: string | null;
  /** Concatenated user-facing text for the turn (response text or user message). */
  text: string;
  /** Compact one-line summary of tool calls in this turn (context only). */
  toolSummary: string | null;
  /** Attribution: which trace this message belongs to. */
  traceId: string;
  /** Filter grain. */
  threadTs: string | null;
  /** Already has an eval_response_scores row → never re-scored. */
  alreadyScored: boolean;
  createdAt: Date;
}

/**
 * A sliding window: the full context slice plus the set of candidate turns this
 * window OWNS (emits verdicts for). Ownership is exclusive across windows so a
 * response is judged exactly once even though context overlaps.
 */
export interface JudgeWindow {
  /** The full ordered slice shown to the judge (context + owned turns). */
  context: ConversationTurn[];
  /** textPartId markers (a stable id, never positional) the judge must echo. */
  ownedPartIds: string[];
}

/** Verdict + selectivity fields the judge decides per response. */
export const verdictEnum = z.enum(["fulfilled", "partial", "failed"]);
export const failureClassEnum = z.enum([
  "missing_cred",
  "bad_memory",
  "bad_harness",
  "missing_tool",
  "reasoning",
  "latency",
  "none",
]);

/**
 * One judge verdict element. `part_id` is ECHOED back from the injected
 * `[R:part_id]` marker so we can map by id, never by array position — a merged/
 * split turn or tool-only step would otherwise silently shift the join.
 */
export const judgeVerdictSchema = z.object({
  part_id: z
    .string()
    .describe(
      "Echo the exact id from the [R:<id>] marker on the assistant turn you are scoring. Map by this id, never by position.",
    ),
  scorable: z
    .boolean()
    .describe(
      "true only for turns that CLOSE or FUMBLE a user intent. false for acks, clarifying questions, and tool-relay/no-op turns.",
    ),
  verdict: verdictEnum
    .nullable()
    .describe(
      "fulfilled | partial | failed. null when scorable=false (do not force a verdict).",
    ),
  serving_intent: z
    .string()
    .describe(
      "The nearest open user request this response is serving, in a short phrase. Topic switches need no detection: just point at the new request.",
    ),
  resolved_in_window: z
    .boolean()
    .describe(
      "true if this turn hedged/deferred but the SAME intent was actually closed within the visible window (honest hedging → PASS). false if it stayed open or was a confident-but-wrong answer (confabulation → FAIL).",
    ),
  failure_class: failureClassEnum.describe(
    "Root cause when verdict=failed; 'none' otherwise.",
  ),
  note: z
    .string()
    .describe("One concise sentence explaining the verdict (or why not scorable)."),
});

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export const judgeOutputSchema = z.object({
  verdicts: z
    .array(judgeVerdictSchema)
    .describe("One entry per assistant turn marked [R:<id>] in the transcript."),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;
