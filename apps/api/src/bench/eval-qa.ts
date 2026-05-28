import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { Memory } from "@aura/db/schema";
import { formatMemoriesForPrompt } from "../memory/format-for-prompt.js";
import { getBenchLanguageModel } from "./models.js";
import type { BenchCase, JudgeVerdict } from "./types.js";
import { buildJudgePrompt, QA_JUDGE_SYSTEM } from "./judge.js";

const verdictSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect", "abstain_ok"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const ANSWER_SYSTEM = `Answer ONLY using the provided memories. If the memories do not contain enough information, reply exactly: "I don't know." Do not use outside knowledge.`;

export async function answerFromMemories(
  benchCase: BenchCase,
  memories: Memory[],
  modelId: string,
): Promise<string> {
  if (memories.length === 0) return "I don't know.";

  const model = await getBenchLanguageModel(modelId);
  const memoryBlock = formatMemoriesForPrompt(memories);
  const { text } = await generateText({
    model,
    system: ANSWER_SYSTEM,
    prompt: `Memories:\n${memoryBlock}\n\nQuestion: ${benchCase.question}`,
    temperature: 0,
  });
  return text.trim();
}

export async function judgeAnswer(params: {
  benchCase: BenchCase;
  answer: string;
  modelId: string;
}): Promise<{
  verdict: JudgeVerdict;
  qaCorrect: boolean;
  rationale: string;
  confidence: number;
}> {
  const { benchCase, answer, modelId } = params;
  const lower = answer.toLowerCase();
  const abstained =
    answer.length === 0 ||
    lower.includes("i don't know") ||
    lower.includes("i do not know");

  if (benchCase.abstention && abstained) {
    return {
      verdict: "abstain_ok",
      qaCorrect: true,
      rationale: "Expected abstention; model abstained.",
      confidence: 1,
    };
  }

  const gold =
    typeof benchCase.goldAnswer === "string"
      ? benchCase.goldAnswer
      : benchCase.goldAnswer.join(" | ");

  const model = await getBenchLanguageModel(modelId);
  const { object } = await generateObject({
    model,
    schema: verdictSchema,
    system: QA_JUDGE_SYSTEM,
    prompt: buildJudgePrompt(benchCase.question, gold, answer, benchCase.abstention),
    temperature: 0,
  });

  const verdict = object.verdict as JudgeVerdict;
  const qaCorrect = verdict === "correct" || verdict === "abstain_ok";

  return {
    verdict,
    qaCorrect,
    rationale: object.rationale,
    confidence: object.confidence,
  };
}
