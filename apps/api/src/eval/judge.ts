/**
 * The windowed eval judge (Machine A).
 *
 * One Sonnet call over an N-turn window amortizes cost AND supplies the shared
 * context that makes each atomic verdict correct. The judge:
 *   - reads the whole window (preceding + a few following turns),
 *   - emits ONE verdict per assistant turn marked `[R:<part_id>]`,
 *   - ECHOES the part_id so we map by id, never by array position.
 *
 * Selectivity ("every response is scorable, but don't score ALL") is a JUDGE
 * OUTPUT, not a sampling decision: the judge marks `scorable:false` for acks,
 * clarifying questions, and tool-relay turns, and only commits a verdict on
 * turns that close or fumble an intent.
 *
 * Anti-circularity: the judge model MUST NOT be Opus (Aura's own main tier) —
 * a model should not grade its own family's output (self-preference). Defaults
 * to Sonnet; override with EVAL_JUDGE_MODEL (a gateway id or fast|main tier).
 */

import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import {
  getFastModel,
  getFastModelId,
  getMainModel,
  withAnthropicFallback,
} from "../lib/ai.js";
import { aiTelemetry, withTrace } from "../lib/langfuse.js";
import { logger } from "../lib/logger.js";
import {
  judgeOutputSchema,
  type ConversationTurn,
  type JudgeVerdict,
  type JudgeWindow,
} from "./types.js";

const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-4.6";
const JUDGE_TIMEOUT_MS = 120_000;
const MAX_TURN_TEXT_CHARS = 2_000;

const SYSTEM_PROMPT = `You are Aura's interaction grader. Aura is an autonomous AI agent embedded in a company Slack workspace. You read a window of a conversation and decide, for each of Aura's responses, whether it FULFILLED the user's intent.

You are given a chronological transcript. Aura's responses you must grade are marked with a stable id like [R:abc-123]. Tool steps and unmarked turns are CONTEXT — read them, do not grade them.

For EACH marked response, output one verdict object and ECHO its exact [R:<id>] value in part_id. Map by id, never by position — a tool-only step or a merged turn would otherwise shift a positional join onto the wrong response.

Decide these fields per response:

- scorable: true ONLY for turns that close out or fumble a user intent. Set false for acknowledgements ("on it", "got it"), clarifying questions, and tool-relay/no-op turns. Selectivity is your call — do not force a verdict on every turn.

- serving_intent: the nearest still-open user request this response serves, as a short phrase. When the user pivots topic, simply point at the new request — do NOT try to segment the thread.

- verdict (null when scorable=false):
  - fulfilled: the response correctly and completely served the intent.
  - partial: it served the intent but left a meaningful gap.
  - failed: it was wrong, fabricated/confabulated, refused an answerable ask, or never delivered what was asked.

- resolved_in_window: This is the single boolean that separates HONEST HEDGING from CONFABULATION.
  - true: the response hedged/deferred/asked for input BUT the SAME intent was actually resolved within the visible window (e.g. a colleague fed the missing context two turns later and the draft got written). Honest hedging that gets resolved is NOT a failure.
  - false: the intent stayed open, OR the response was a confident answer that was actually wrong. A confident, fluent, wrong answer that matched no obvious red-flag phrase is still a failure.

- failure_class (only meaningful when verdict=failed; else "none"):
  - missing_cred: lacked a credential/permission/access it needed.
  - bad_memory: recalled or relied on wrong/stale memory.
  - bad_harness: a harness/runtime/tool-plumbing defect (crash, truncation, bad routing).
  - missing_tool: needed a capability it does not have.
  - reasoning: a logic/planning/comprehension mistake.
  - latency: too slow / timed out to be useful.

- note: one concise sentence explaining the verdict.

Grade the response on whether intent was fulfilled, judged with the surrounding context — NOT on tone or verbosity. Output exactly one verdict per marked response.`;

interface ResolvedJudge {
  model: Awaited<ReturnType<typeof getMainModel>>["model"];
  modelId: string;
}

/** Resolve the judge model: EVAL_JUDGE_MODEL (gateway id or tier) > Sonnet. */
export async function resolveJudgeModel(): Promise<ResolvedJudge> {
  const raw = (process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL).trim();
  if (raw === "fast") {
    return { model: await getFastModel(), modelId: await getFastModelId() };
  }
  if (raw === "main") {
    // Allowed as an explicit escape hatch, but discouraged (self-preference).
    const { model, modelId } = await getMainModel();
    return { model, modelId };
  }
  const id = raw.includes("/") ? raw : DEFAULT_JUDGE_MODEL;
  return { model: withAnthropicFallback(gateway(id), id), modelId: id };
}

function truncate(text: string, max = MAX_TURN_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated]`;
}

/** Render one transcript line; mark owned assistant turns with [R:<id>]. */
function renderTurn(turn: ConversationTurn, owned: Set<string>): string {
  const ts = turn.createdAt.toISOString();
  if (turn.role === "user") {
    return `[user @ ${ts}] ${truncate(turn.text)}`;
  }
  if (turn.role === "assistant") {
    const parts: string[] = [];
    if (turn.textPartId && owned.has(turn.textPartId)) {
      parts.push(`[R:${turn.textPartId}] [assistant @ ${ts}] ${truncate(turn.text)}`);
    } else if (turn.text) {
      parts.push(`[assistant @ ${ts}] ${truncate(turn.text)}`);
    }
    if (turn.toolSummary) {
      parts.push(`  ↳ tools: ${truncate(turn.toolSummary, 500)}`);
    }
    return parts.join("\n") || `[assistant @ ${ts}] (no text)`;
  }
  return `[${turn.role} @ ${ts}] ${truncate(turn.text)}`;
}

function buildTranscript(window: JudgeWindow): string {
  const owned = new Set(window.ownedPartIds);
  return window.context.map((t) => renderTurn(t, owned)).join("\n");
}

export interface JudgeWindowResult {
  /** Verdicts keyed back by the echoed part_id (id-mapped, never positional). */
  byPartId: Map<string, JudgeVerdict>;
  modelId: string;
}

/**
 * Run the judge over a single window. Returns verdicts mapped by part_id.
 * Hallucinated ids (not in ownedPartIds) are dropped; missing ids are simply
 * absent (the caller decides how to backfill).
 */
export async function judgeWindow(window: JudgeWindow): Promise<JudgeWindowResult> {
  const { model, modelId } = await resolveJudgeModel();
  const owned = new Set(window.ownedPartIds);

  const transcript = buildTranscript(window);
  const prompt = `Transcript window (${window.context.length} turns; grade only the ${window.ownedPartIds.length} responses marked [R:<id>]):

${transcript}

Return one verdict per marked response, echoing each [R:<id>] in part_id.`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), JUDGE_TIMEOUT_MS);

  try {
    const { object } = await withTrace(
      {
        traceName: "eval-funnel-judge",
        tags: ["channel:eval-funnel"],
        metadata: { ownedCount: window.ownedPartIds.length, judgeModel: modelId },
      },
      () =>
        generateObject({
          model,
          schema: judgeOutputSchema,
          experimental_telemetry: aiTelemetry("eval-funnel-judge"),
          system: SYSTEM_PROMPT,
          prompt,
          temperature: 0,
          abortSignal: abort.signal,
        }),
    );

    const byPartId = new Map<string, JudgeVerdict>();
    for (const v of object.verdicts) {
      // Map by id, never index. Drop ids the judge invented.
      if (owned.has(v.part_id)) byPartId.set(v.part_id, v);
    }

    const missing = window.ownedPartIds.filter((id) => !byPartId.has(id));
    if (missing.length > 0) {
      logger.warn("eval judge: window missing verdicts for some responses", {
        modelId,
        missing: missing.length,
        owned: window.ownedPartIds.length,
      });
    }

    return { byPartId, modelId };
  } finally {
    clearTimeout(timer);
  }
}
