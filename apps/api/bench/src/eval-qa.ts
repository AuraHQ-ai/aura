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
import { gateway } from "@ai-sdk/gateway";
import type { Memory } from "@aura/db/schema";
import type { BenchCase, PerCaseResult } from "./types.js";
import { withAnthropicFallback } from "../../src/lib/ai.js";
import { DEFAULT_ANSWERER_MODEL } from "./models.js";
import { judgeAnswer } from "./judge.js";

/**
 * Formatter that mirrors the production memory-injection format.
 *
 * Production uses `formatMemories()` in `apps/api/src/personality/system-prompt.ts`.
 * We re-implement the same shape here (newest-first bullet list with type
 * tag and relative time) rather than importing it to keep this module
 * decoupled from the system-prompt module's other dependencies.
 */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) {
    return "(no memories available)";
  }
  return memories
    .map((m) => {
      const validFromIso = m.validFrom
        ? new Date(m.validFrom).toISOString().slice(0, 10)
        : new Date(m.createdAt).toISOString().slice(0, 10);
      const users =
        m.relatedUserIds.length > 0
          ? ` [about: ${m.relatedUserIds.join(", ")}]`
          : "";
      return `- [${m.type}] ${m.content} (recorded ${validFromIso})${users}`;
    })
    .join("\n");
}

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
  const modelId = config.modelId ?? DEFAULT_ANSWERER_MODEL;
  const memoryBlock = formatMemoriesForPrompt(retrieved);

  const userPrompt = `Memories:\n${memoryBlock}\n\nQuestion: ${benchCase.question}\n\nAnswer:`;

  let modelAnswer = "";
  try {
    const result = await generateText({
      model: withAnthropicFallback(gateway(modelId), modelId),
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
