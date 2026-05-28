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

export { formatMemoriesForPrompt };

const ANSWERER_SYSTEM = `You are a strict grounded question-answerer.

You will receive a list of memories that were retrieved from a long-term memory store, and a single question. Answer ONLY from the provided memories. Be terse.

Rules:
- If the memories do not contain enough information to answer, respond exactly with: "I don't know."
- Do not invent facts.
- Do not use outside world knowledge.
- For dates, copy the date verbatim from the memory if present (e.g. "March 2024").
- For factual answers, prefer the SHORTEST faithful answer (a name, a number, a phrase).
- Do not add commentary. Output only the answer.`;

interface AnswerConfig {
  modelId?: string;
  judgeModelId?: string;
}

/**
 * Ask one BenchCase against retrieved memories and judge the result.
 */
export async function evaluateQA(
  benchCase: BenchCase,
  retrieved: Memory[],
  config: AnswerConfig = {},
): Promise<Pick<PerCaseResult, "modelAnswer" | "judgeVerdict" | "judgeConfidence" | "judgeRationale">> {
  const memoryBlock = formatMemoriesForPrompt(retrieved);
  const userPrompt = `Memories:\n${memoryBlock || "(no memories available)"}\n\nQuestion: ${benchCase.question}\n\nAnswer:`;

  const { model, modelId } = await resolveBenchAnswererModel(config.modelId);
  void modelId; // recorded on the run row by the orchestrator

  let modelAnswer = "";
  try {
    const result = await generateText({
      model,
      system: ANSWERER_SYSTEM,
      prompt: userPrompt,
      temperature: 0,
    });
    modelAnswer = (result.text ?? "").trim();
  } catch (error) {
    modelAnswer = "";
    return {
      modelAnswer,
      judgeVerdict: "skipped",
      judgeConfidence: 0,
      judgeRationale: `answerer error: ${String(error).slice(0, 120)}`,
    };
  }

  try {
    const judge = await judgeAnswer(benchCase, modelAnswer, {
      modelId: config.judgeModelId,
    });
    return {
      modelAnswer,
      judgeVerdict: judge.verdict,
      judgeConfidence: judge.confidence,
      judgeRationale: judge.rationale,
    };
  } catch (error) {
    return {
      modelAnswer,
      judgeVerdict: "skipped",
      judgeConfidence: 0,
      judgeRationale: `judge error: ${String(error).slice(0, 120)}`,
    };
  }
}
