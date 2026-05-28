/**
 * Bench-only model defaults.
 *
 * The harness pins models explicitly instead of inheriting from production
 * settings. Rationale (#1043 follow-up): we want bench numbers to stay
 * comparable across the codebase even when production swaps its fast
 * model, AND we want to score the system with the best models we'd
 * realistically deploy so that retrieval / extractor bugs become the
 * bottleneck — not LLM capability.
 *
 * The CLI accepts --extraction-model and --judge-model to override these
 * for ad-hoc experiments. The defaults below land in nightly CI and in
 * the PR-time bench unless overridden.
 */

const ENV_EXTRACTION = "BENCH_EXTRACTION_MODEL";
const ENV_ANSWERER = "BENCH_ANSWERER_MODEL";
const ENV_JUDGE = "BENCH_JUDGE_MODEL";

/** Sonnet — the strongest fast extractor we'd consider running. */
export const DEFAULT_EXTRACTION_MODEL = "anthropic/claude-sonnet-4.6";
/** Sonnet — same model the agent uses for conversation by default. */
export const DEFAULT_ANSWERER_MODEL = "anthropic/claude-sonnet-4.6";
/** Opus — most discerning judge available. */
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-opus-4.6";

export interface BenchModels {
  extraction: string;
  answerer: string;
  judge: string;
}

/**
 * Resolve the bench's three model slots.
 *
 * Priority: CLI override > env var > built-in default. Env vars exist so
 * the GitHub Action / Vercel cron can pin specific versions without
 * shipping a new commit.
 */
export function resolveBenchModels(overrides: Partial<BenchModels> = {}): BenchModels {
  return {
    extraction:
      overrides.extraction ??
      process.env[ENV_EXTRACTION] ??
      DEFAULT_EXTRACTION_MODEL,
    answerer:
      overrides.answerer ??
      process.env[ENV_ANSWERER] ??
      DEFAULT_ANSWERER_MODEL,
    judge:
      overrides.judge ?? process.env[ENV_JUDGE] ?? DEFAULT_JUDGE_MODEL,
  };
}
