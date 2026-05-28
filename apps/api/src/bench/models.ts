import { gateway } from "@ai-sdk/gateway";
import { withAnthropicFallback, type WrappableModel } from "../lib/ai.js";

const ENV_EXTRACTION = "BENCH_EXTRACTION_MODEL";
const ENV_ANSWERER = "BENCH_ANSWERER_MODEL";
const ENV_JUDGE = "BENCH_JUDGE_MODEL";

export const DEFAULT_EXTRACTION_MODEL = "anthropic/claude-sonnet-4.6";
export const DEFAULT_ANSWERER_MODEL = "anthropic/claude-sonnet-4.6";
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-opus-4.6";

export interface BenchModels {
  extraction: string;
  answerer: string;
  judge: string;
}

export function resolveBenchModels(overrides: Partial<BenchModels> = {}): BenchModels {
  return {
    extraction:
      overrides.extraction ??
      process.env[ENV_EXTRACTION] ??
      DEFAULT_EXTRACTION_MODEL,
    answerer:
      overrides.answerer ?? process.env[ENV_ANSWERER] ?? DEFAULT_ANSWERER_MODEL,
    judge: overrides.judge ?? process.env[ENV_JUDGE] ?? DEFAULT_JUDGE_MODEL,
  };
}

export async function getBenchLanguageModel(modelId: string): Promise<WrappableModel> {
  return withAnthropicFallback(gateway(modelId), modelId);
}
