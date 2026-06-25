/**
 * LLM batch judge for the eval funnel (Machine A).
 *
 * One cheap (fast-tier) structured call per 20-turn window. The single
 * question per assistant response is "was the user's intent fulfilled?" —
 * judged with surrounding context so honest hedging that resolves later in
 * the window (resolved_in_window) is separated from confident confabulation.
 *
 * CRITICAL: verdicts are mapped back by the echoed `part_id`, never by array
 * position. A positional join silently scores the wrong response when the
 * judge merges/splits/omits a turn.
 */
import { z } from "zod";
import { generateObject } from "ai";
import { evalVerdicts, evalFailureClasses } from "@aura/db/schema";
import type { EvalVerdict, EvalFailureClass } from "@aura/db/schema";
import { getFastModel, getFastModelId } from "../lib/ai.js";
import { aiTelemetry, withTrace } from "../lib/langfuse.js";
import { logger } from "../lib/logger.js";
import type { EvalWindow } from "./windowing.js";
import { renderWindowTranscript } from "./windowing.js";

const JUDGE_TIMEOUT_MS = 120_000;

export const judgeEntrySchema = z.object({
  part_id: z
    .string()
    .describe("The id from the [R:<part_id>] marker, echoed back EXACTLY."),
  scorable: z
    .boolean()
    .describe(
      "True only for turns that close out or fumble a user intent. False for acks, clarifying questions, status updates, and tool-relay turns.",
    ),
  verdict: z
    .enum(evalVerdicts)
    .nullable()
    .describe("Was the serving intent fulfilled? Null when scorable is false."),
  failure_class: z
    .enum(evalFailureClasses)
    .nullable()
    .describe("Why the response failed/partially failed. Null or 'none' otherwise."),
  serving_intent: z
    .string()
    .nullable()
    .describe(
      "Short description of the nearest open user request this response serves.",
    ),
  resolved_in_window: z
    .boolean()
    .describe(
      "True when this turn hedged or deferred, but the intent visibly closed later within this window.",
    ),
  note: z
    .string()
    .nullable()
    .describe("One or two sentences of evidence for the verdict."),
});

export const judgeWindowSchema = z.object({
  responses: z.array(judgeEntrySchema),
});

export type JudgeEntry = z.infer<typeof judgeEntrySchema>;

export interface JudgedResponse {
  partId: string;
  scorable: boolean;
  verdict: EvalVerdict | null;
  failureClass: EvalFailureClass;
  servingIntent: string | null;
  resolvedInWindow: boolean;
  note: string | null;
}

const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge reading transcripts between users and Aura, an AI agent operating inside a company Slack workspace. Your single question for each marked assistant response is: **was the user's intent fulfilled?**

You receive a sliding window of conversation turns. Assistant turns are marked with stable ids like [R:abc-123]. For EVERY marked assistant turn that is not labelled "context only", emit exactly one entry in the responses array, echoing the marker id EXACTLY in part_id. Never invent, merge, or reorder ids.

Per response, decide:

1. **scorable** — true only for turns that close out or fumble a user intent. Mark scorable: false for acknowledgements ("on it"), clarifying questions, progress narration, and tool-relay chatter. Do NOT force a verdict on every turn — but a confident wrong answer is ALWAYS scorable (scorable: true, verdict: failed).

2. **serving_intent** — attribute the response to the nearest open user request in the window, as short free text (e.g. "draft the Bettina follow-up email"). When the user pivots topic, the next response simply points at a different request — never try to segment the conversation.

3. **verdict** (when scorable):
   - fulfilled — the intent was satisfied: correct, complete, grounded in the evidence visible in the window.
   - partial — meaningful progress but incomplete, partially wrong, or required the user to re-ask.
   - failed — the intent was not satisfied: wrong answer, confident confabulation (claims not supported by tool output or context), refused something it could do, or silently dropped the ask.

4. **resolved_in_window** — true when THIS turn hedged or said it couldn't do something yet, but the intent visibly closed later within the window (e.g. the user supplied missing context two turns later and the work got done). An honest hedge that resolves is fulfilled/partial, NOT failed. A confident answer that sounds fine but is unsupported is failed even if nobody complained.

5. **failure_class** (for partial/failed):
   - missing_cred — lacked credentials/permissions/access to a system it needed.
   - bad_memory — forgot, misremembered, or failed to recall context it had been given.
   - bad_harness — infrastructure/pipeline misbehavior: truncated/duplicated output, crashed mid-response, tool plumbing errors.
   - missing_tool — no tool/capability existed for what the user asked.
   - reasoning — had the information and capability but reasoned to a wrong/confabulated/low-quality answer.
   - latency — fulfilled far too slowly or timed out.
   - none — use for fulfilled or non-scorable turns.

6. **note** — one or two sentences of concrete evidence ("claimed the Claap recording summarized X but no tool output contains it").

Be strict about confabulation: text that asserts specific facts, numbers, or outcomes with no supporting tool output or user-provided context in the window is a failed verdict, however fluent it sounds.`;

export interface JudgeWindowOptions {
  /** Identifier used for tracing (thread key or trace id). */
  sessionId?: string;
  /** Injected for tests. */
  generate?: typeof generateObject;
}

export interface JudgeWindowResult {
  /** part_id -> judged verdict, for every owned part id (omissions filled in). */
  judged: Map<string, JudgedResponse>;
  judgeModel: string;
  /** Ids the judge returned that we did not ask for (logged, dropped). */
  unknownIds: string[];
  /** Owned ids the judge failed to echo (stored as non-scorable placeholders). */
  omittedIds: string[];
}

function normalizeEntry(entry: JudgeEntry): JudgedResponse {
  const scorable = entry.scorable;
  const verdict = scorable ? entry.verdict : null;
  const failureClass: EvalFailureClass =
    verdict === "failed" || verdict === "partial"
      ? (entry.failure_class ?? "none")
      : "none";
  return {
    partId: entry.part_id,
    scorable,
    verdict,
    failureClass,
    servingIntent: entry.serving_intent?.trim() || null,
    resolvedInWindow: entry.resolved_in_window,
    note: entry.note?.trim() || null,
  };
}

/**
 * Judge one window. Always returns an entry for every owned part id:
 * verdicts the judge echoed are mapped by id; owned ids the judge omitted are
 * recorded as non-scorable placeholders so the batch stays idempotent (we
 * never want a permanently "unscored" response re-judged every night).
 */
export async function judgeWindow(
  window: EvalWindow,
  options: JudgeWindowOptions = {},
): Promise<JudgeWindowResult> {
  const generate = options.generate ?? generateObject;
  const [model, judgeModel] = await Promise.all([
    getFastModel(),
    getFastModelId(),
  ]);

  const transcript = renderWindowTranscript(window);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), JUDGE_TIMEOUT_MS);

  let entries: JudgeEntry[];
  try {
    const { object } = await withTrace(
      {
        traceName: "eval-response-judge",
        sessionId: options.sessionId,
        tags: ["channel:eval-judge"],
        metadata: { ownedResponses: window.ownedPartIds.length },
      },
      () =>
        generate({
          model,
          schema: judgeWindowSchema,
          experimental_telemetry: aiTelemetry("eval-response-judge"),
          system: JUDGE_SYSTEM_PROMPT,
          prompt: `Score the marked assistant responses in this transcript window.\n\nThe responses to score are: ${window.ownedPartIds.map((id) => `[R:${id}]`).join(", ")}\n\n<transcript>\n${transcript}\n</transcript>`,
          temperature: 0,
          abortSignal: abortController.signal,
        }),
    );
    entries = (object as z.infer<typeof judgeWindowSchema>).responses;
  } finally {
    clearTimeout(timer);
  }

  const ownedSet = new Set(window.ownedPartIds);
  const judged = new Map<string, JudgedResponse>();
  const unknownIds: string[] = [];

  for (const entry of entries) {
    // Tolerate judges echoing the full "[R:...]" wrapper.
    const partId = entry.part_id.replace(/^\[R:(.+)\]$/, "$1").trim();
    if (!ownedSet.has(partId)) {
      unknownIds.push(partId);
      continue;
    }
    // First echo wins; duplicate echoes for the same id are dropped.
    if (!judged.has(partId)) {
      judged.set(partId, normalizeEntry({ ...entry, part_id: partId }));
    }
  }

  const omittedIds = window.ownedPartIds.filter((id) => !judged.has(id));
  for (const partId of omittedIds) {
    judged.set(partId, {
      partId,
      scorable: false,
      verdict: null,
      failureClass: "none",
      servingIntent: null,
      resolvedInWindow: false,
      note: "Judge did not return a verdict for this response (omitted from output).",
    });
  }

  if (unknownIds.length > 0 || omittedIds.length > 0) {
    logger.warn("eval judge id mismatch", {
      unknownIds,
      omittedIds,
      owned: window.ownedPartIds.length,
    });
  }

  return { judged, judgeModel, unknownIds, omittedIds };
}
