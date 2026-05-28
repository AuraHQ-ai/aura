import { gateway } from "@ai-sdk/gateway";

export const DEFAULT_EXTRACTION_MODEL = "anthropic/claude-sonnet-4.6";
export const DEFAULT_ANSWER_MODEL = "anthropic/claude-sonnet-4.6";
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-opus-4.7";

export interface BenchModels {
  extraction: string;
  answer: string;
  judge: string;
}

export function resolveBenchModels(overrides: Partial<BenchModels> = {}): BenchModels {
  return {
    extraction:
      overrides.extraction ??
      process.env.MEMORY_BENCH_EXTRACTION_MODEL ??
      DEFAULT_EXTRACTION_MODEL,
    answer:
      overrides.answer ??
      process.env.MEMORY_BENCH_ANSWER_MODEL ??
      DEFAULT_ANSWER_MODEL,
    judge:
      overrides.judge ??
      process.env.MEMORY_BENCH_JUDGE_MODEL ??
      DEFAULT_JUDGE_MODEL,
  };
}

export async function getBenchLanguageModel(modelId?: string) {
  const resolved = modelId ?? DEFAULT_ANSWER_MODEL;
  const { withAnthropicFallback } = await import("../../src/lib/ai.js");
  return withAnthropicFallback(gateway(resolved), resolved);
}
