import type { LanguageModel } from "ai";
import { getFastModel, getMainModel, getMainModelId, getEscalationModel } from "../lib/ai.js";

export type BenchModelTier = "fast" | "main" | "escalation";

function tierFromEnv(value: string | undefined, defaultTier: BenchModelTier): BenchModelTier {
  if (value === "fast" || value === "main" || value === "escalation") return value;
  return defaultTier;
}

async function modelForTier(tier: BenchModelTier): Promise<LanguageModel> {
  if (tier === "fast") return getFastModel();
  if (tier === "escalation") return (await getEscalationModel()).model;
  return (await getMainModel()).model;
}

async function modelIdForTier(tier: BenchModelTier): Promise<string> {
  const { getFastModelId } = await import("../lib/ai.js");
  if (tier === "fast") return getFastModelId();
  if (tier === "escalation") return (await getEscalationModel()).modelId;
  return getMainModelId();
}

/** Extraction LLM for bench runs (default: main / Sonnet-class). */
export async function getBenchExtractionModel(): Promise<LanguageModel> {
  return modelForTier(tierFromEnv(process.env.AURA_BENCH_EXTRACTION, "main"));
}

/** Constrained answerer for QA eval (default: main). */
export async function getBenchAnswerModel(): Promise<LanguageModel> {
  return modelForTier(tierFromEnv(process.env.AURA_BENCH_ANSWER, "main"));
}

/** Judge for QA scoring (default: escalation / Opus-class). */
export async function getBenchJudgeModel(): Promise<LanguageModel> {
  return modelForTier(tierFromEnv(process.env.AURA_BENCH_JUDGE, "escalation"));
}

export async function resolveBenchRunModelIds(): Promise<{
  extraction: string;
  answer: string;
  judge: string;
}> {
  const [extraction, answer, judge] = await Promise.all([
    modelIdForTier(tierFromEnv(process.env.AURA_BENCH_EXTRACTION, "main")),
    modelIdForTier(tierFromEnv(process.env.AURA_BENCH_ANSWER, "main")),
    modelIdForTier(tierFromEnv(process.env.AURA_BENCH_JUDGE, "escalation")),
  ]);
  return { extraction, answer, judge };
}
