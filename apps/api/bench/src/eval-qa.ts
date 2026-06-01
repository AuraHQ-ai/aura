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
// Reuse the EXACT <related_threads> block production injects, instead of
// formatting conversations a second way in the harness.
import { formatConversations } from "../../src/personality/system-prompt.js";
import type { ConversationThread } from "../../src/memory/retrieve.js";
import { resolveBenchAnswererModel } from "./models.js";
import { resolveQuestionDate } from "./fixtures.js";
import { judgeAnswer } from "./judge.js";
import type { CostStage, UsageLike } from "./cost-meter.js";

export { formatMemoriesForPrompt };

const ANSWERER_SYSTEM = `You are a strict grounded question-answerer.

You will receive the current date, a list of memories that were retrieved from a long-term memory store, optionally a <related_threads> block of relevant past conversation pointers, and a single question. Answer ONLY from the provided memories and related threads. Be terse.

Rules:
- Every fact in your answer MUST come from the memories or the related threads. Do not use outside world knowledge and do not invent facts.
- You MAY reason over the memories to derive an answer the question asks for: count matching items, add or subtract quantities, order events by their dates, and compute elapsed time or relative dates between dated memories. Use only values present in the memories as inputs.
- The relative times shown in the memories (e.g. "3 months ago") and any relative time in the question are anchored to the CURRENT DATE provided above. Use it to resolve "ago"/"last week"/etc.
- Only respond exactly with "I don't know." when the memories genuinely lack the information needed (including the inputs required to derive it). Do not abstain merely because no single memory states the answer verbatim.
- For dates, copy the date verbatim from the memory if present (e.g. "March 2024"). When the question asks for a duration or relative time, compute it from the dated memories.
- For factual answers, prefer the SHORTEST faithful answer (a name, a number, a phrase).
- Do not add commentary. Output only the answer.`;

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

interface AnswerConfig {
  modelId?: string;
  judgeModelId?: string;
  /**
   * Relevant past conversation threads from production's `retrieveConversations`,
   * injected as the same `<related_threads>` block the agent sees. Empty/omitted
   * → memories-only behaviour.
   */
  conversations?: ConversationThread[];
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
  // The answerer's "now" is the question's own instant on the timeline — the
  // same T_Q the as-of retrieval and the watermark release use. Keeps relative
  // gold answers ("five months ago") anchored consistently across all lanes.
  const referenceNow = resolveQuestionDate(benchCase);
  const memoryBlock = formatMemoriesForPrompt(retrieved, referenceNow);
  const nowLine = `Current date: ${referenceNow.toISOString().slice(0, 10)}`;
  const conversationBlock = formatConversations(config.conversations ?? []);
  const conversationSection = conversationBlock
    ? `\n\n${conversationBlock}`
    : "";
  const userPrompt = `${nowLine}\n\nMemories:\n${memoryBlock || "(no memories available)"}${conversationSection}\n\nQuestion: ${benchCase.question}\n\nAnswer:`;

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
