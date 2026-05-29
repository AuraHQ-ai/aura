/**
 * End-to-end QA scoring.
 *
 * For each case we:
 *   1. Take the retrieved memories from the recall lane (no double-fetching).
 *   2. Format them with the same helper production uses (`formatMemoriesForPrompt`).
 *   3. Ask a CONSTRAINED answerer — no tools, no personality, no streaming —
 *      to answer only from those memories.
 *   4. Pipe the answer + gold to the LLM judge from `judge.ts`.
 *
 * The constrained answerer is intentionally minimal. The harness measures
 * the MEMORY subsystem, not the full agent — adding tools or personality
 * would add noise.
 */

import { generateText } from "ai";
import type { Memory } from "@aura/db/schema";
import type { BenchCase, PerCaseResult } from "./types.js";
// The bench MUST format memories exactly the way production does, otherwise
// the QA score measures the formatting difference rather than the memory
// pipeline. We import the same helper buildSystemPrompt() uses.
import { formatMemoriesForPrompt } from "../../src/memory/format-for-prompt.js";
import { resolveBenchAnswererModel } from "./models.js";
import { judgeAnswer } from "./judge.js";
import type { CostStage, UsageLike } from "./cost-meter.js";

export { formatMemoriesForPrompt };

const ANSWERER_SYSTEM = `You are a strict grounded question-answerer.

You will receive the current date, a list of memories that were retrieved from a long-term memory store, and a single question. Answer ONLY from the provided memories. Be terse.

Rules:
- Every fact in your answer MUST come from the memories. Do not use outside world knowledge and do not invent facts.
- You MAY reason over the memories to derive an answer the question asks for: count matching items, add or subtract quantities, order events by their dates, and compute elapsed time or relative dates between dated memories. Use only values present in the memories as inputs.
- The relative times shown in the memories (e.g. "3 months ago") and any relative time in the question are anchored to the CURRENT DATE provided above. Use it to resolve "ago"/"last week"/etc.
- Only respond exactly with "I don't know." when the memories genuinely lack the information needed (including the inputs required to derive it). Do not abstain merely because no single memory states the answer verbatim.
- For dates, copy the date verbatim from the memory if present (e.g. "March 2024"). When the question asks for a duration or relative time, compute it from the dated memories.
- For factual answers, prefer the SHORTEST faithful answer (a name, a number, a phrase).
- Do not add commentary. Output only the answer.`;

/**
 * Resolve the reference "now" for a case: the question's own date when the
 * corpus provides one (LongMemEval), else the latest session timestamp, else
 * wall-clock now. Temporal gold answers ("five months ago") are relative to
 * this instant — NOT the real 2026 clock the bench runs on.
 */
/**
 * Estimate the token count of a string with the conventional ~4-chars-per-token
 * heuristic. Deliberately tokenizer-free: the value is model-INDEPENDENT, so the
 * context-efficiency metric stays stable when the answerer/judge model is
 * repointed between runs (a real provider tokenizer would make cross-run deltas
 * confounded by model choice). `memoryChars` is stored alongside so the estimate
 * is auditable.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function resolveReferenceNow(benchCase: BenchCase): Date | undefined {
  if (benchCase.questionDate) {
    const d = new Date(benchCase.questionDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  let latest: number | undefined;
  for (const s of benchCase.sessions) {
    const t = new Date(s.timestamp).getTime();
    if (!Number.isNaN(t) && (latest === undefined || t > latest)) latest = t;
  }
  return latest !== undefined ? new Date(latest) : undefined;
}

interface AnswerConfig {
  modelId?: string;
  judgeModelId?: string;
  /** Optional cost hook: receives (stage, resolved model id, token usage). */
  onUsage?: (stage: CostStage, modelId: string, usage: UsageLike) => void;
}

/**
 * Ask one BenchCase against retrieved memories and judge the result.
 */
export async function evaluateQA(
  benchCase: BenchCase,
  retrieved: Memory[],
  config: AnswerConfig = {},
): Promise<
  Pick<
    PerCaseResult,
    | "modelAnswer"
    | "judgeVerdict"
    | "judgeConfidence"
    | "judgeRationale"
    | "memoryTokens"
    | "memoryChars"
    | "memoryCount"
  >
> {
  const referenceNow = resolveReferenceNow(benchCase);
  const memoryBlock = formatMemoriesForPrompt(retrieved, referenceNow);
  const nowLine = `Current date: ${(referenceNow ?? new Date()).toISOString().slice(0, 10)}`;
  const userPrompt = `${nowLine}\n\nMemories:\n${memoryBlock || "(no memories available)"}\n\nQuestion: ${benchCase.question}\n\nAnswer:`;

  // Context-efficiency signal (mem0 reports quality-per-token). We measure the
  // retrieved-memory block specifically — the part a retrieval/formatter change
  // actually moves — rather than the whole prompt, so the constant answerer
  // system prompt doesn't dilute the signal.
  const memoryChars = memoryBlock.length;
  const memoryTokens = estimateTokens(memoryBlock);
  const memoryCount = retrieved.length;

  const { model, modelId } = await resolveBenchAnswererModel(config.modelId);

  let modelAnswer = "";
  try {
    const result = await generateText({
      model,
      system: ANSWERER_SYSTEM,
      prompt: userPrompt,
      temperature: 0,
    });
    modelAnswer = (result.text ?? "").trim();
    config.onUsage?.("answer", modelId, result.usage);
  } catch (error) {
    modelAnswer = "";
    return {
      modelAnswer,
      judgeVerdict: "skipped",
      judgeConfidence: 0,
      judgeRationale: `answerer error: ${String(error).slice(0, 120)}`,
      memoryTokens,
      memoryChars,
      memoryCount,
    };
  }

  try {
    const judge = await judgeAnswer(benchCase, modelAnswer, {
      modelId: config.judgeModelId,
      onUsage: config.onUsage
        ? (jModelId, usage) => config.onUsage!("judge", jModelId, usage)
        : undefined,
    });
    return {
      modelAnswer,
      judgeVerdict: judge.verdict,
      judgeConfidence: judge.confidence,
      judgeRationale: judge.rationale,
      memoryTokens,
      memoryChars,
      memoryCount,
    };
  } catch (error) {
    return {
      modelAnswer,
      judgeVerdict: "skipped",
      judgeConfidence: 0,
      judgeRationale: `judge error: ${String(error).slice(0, 120)}`,
      memoryTokens,
      memoryChars,
      memoryCount,
    };
  }
}
