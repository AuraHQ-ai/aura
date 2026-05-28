import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { Memory } from "@aura/db/schema";
import { getFastModel } from "../../src/lib/ai.js";
import { formatMemoriesForPrompt } from "../../src/personality/system-prompt.js";
import { QA_ANSWER_SYSTEM, QA_JUDGE_SYSTEM } from "./judge.js";
import type { BenchCase } from "./types.js";

const judgeSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect", "abstain_ok"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export async function answerFromMemories(
  benchCase: BenchCase,
  memories: Memory[],
): Promise<string> {
  if (memories.length === 0) return "I don't know.";

  const model = await getFastModel();
  const memoryBlock = formatMemoriesForPrompt(memories);
  const { text } = await generateText({
    model,
    system: QA_ANSWER_SYSTEM,
    prompt: `Memories:\n${memoryBlock}\n\nQuestion: ${benchCase.question}`,
    temperature: 0,
  });
  return text.trim();
}

export async function judgeAnswer(params: {
  benchCase: BenchCase;
  answer: string;
}): Promise<{
  verdict: "correct" | "partial" | "incorrect" | "abstain_ok";
  qaCorrect: boolean;
  rationale: string;
}> {
  const { benchCase, answer } = params;
  const lower = answer.toLowerCase();
  const abstained = lower.includes("i don't know") || lower.includes("i do not know");

  if (benchCase.abstention && abstained) {
    return {
      verdict: "abstain_ok",
      qaCorrect: true,
      rationale: "Gold case expects abstention and the answer abstained.",
    };
  }

  const model = await getFastModel();
  const { object } = await generateObject({
    model,
    schema: judgeSchema,
    system: QA_JUDGE_SYSTEM,
    prompt: [
      `Question: ${benchCase.question}`,
      `Gold answer: ${Array.isArray(benchCase.goldAnswer) ? benchCase.goldAnswer.join(" | ") : benchCase.goldAnswer}`,
      `Gold abstention: ${benchCase.abstention ? "yes" : "no"}`,
      `Predicted answer: ${answer}`,
    ].join("\n\n"),
    temperature: 0,
  });

  return {
    verdict: object.verdict,
    qaCorrect: object.verdict === "correct" || object.verdict === "abstain_ok",
    rationale: object.rationale,
  };
}
