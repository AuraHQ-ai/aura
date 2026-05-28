import { generateObject, generateText } from "ai";
import { z } from "zod";
import { embedText } from "../lib/embeddings.js";
import { retrieveMemories } from "../memory/retrieve.js";
import { formatMemoriesForPrompt } from "../memory/format-for-prompt.js";
import { getFastModel } from "../lib/ai.js";
import type { BenchCase } from "./types.js";
import { buildJudgePrompt, QA_JUDGE_SYSTEM } from "./judge.js";

const verdictSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect", "abstain_ok"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const ANSWER_SYSTEM = `Answer ONLY using the provided memories. If the memories do not contain enough information, reply exactly: "I don't know." Do not use outside knowledge.`;

export async function answerFromMemories(
  benchCase: BenchCase,
  workspaceId: string,
  generationModelId?: string,
): Promise<{ answer: string; retrievedCount: number }> {
  const queryEmbedding = await embedText(benchCase.question);
  const retrieved = await retrieveMemories({
    query: benchCase.question,
    queryEmbedding,
    currentUserId: `bench:${benchCase.id}:user`,
    workspaceId,
    limit: 15,
    adminMode: true,
  });

  const memoryBlock = formatMemoriesForPrompt(retrieved);
  const model = await getFastModel();
  void generationModelId;

  const { text } = await generateText({
    model,
    system: ANSWER_SYSTEM,
    prompt: `${memoryBlock ? `Memories:\n${memoryBlock}\n\n` : "Memories: (none)\n\n"}Question: ${benchCase.question}`,
    temperature: 0,
  });

  return { answer: text.trim(), retrievedCount: retrieved.length };
}

export async function judgeAnswer(
  benchCase: BenchCase,
  hypothesis: string,
): Promise<{ correct: boolean; verdict: string }> {
  const gold =
    typeof benchCase.goldAnswer === "string"
      ? benchCase.goldAnswer
      : benchCase.goldAnswer.join(" | ");

  if (benchCase.abstention) {
    const lower = hypothesis.toLowerCase();
    const abstained =
      retrievedNothing(hypothesis) ||
      lower.includes("don't know") ||
      lower.includes("do not know") ||
      lower.includes("insufficient") ||
      lower.includes("no information");
    if (abstained) {
      return { correct: true, verdict: "abstain_ok" };
    }
  }

  const model = await getFastModel();
  const { object } = await generateObject({
    model,
    schema: verdictSchema,
    system: QA_JUDGE_SYSTEM,
    prompt: buildJudgePrompt(benchCase.question, gold, hypothesis, benchCase.abstention),
    temperature: 0,
  });

  const correct = object.verdict === "correct" || object.verdict === "abstain_ok";

  return { correct, verdict: object.verdict };
}

function retrievedNothing(hypothesis: string): boolean {
  return hypothesis.length === 0;
}
