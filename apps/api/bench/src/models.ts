/**
 * Bench-only model resolution.
 *
 * The bench operates over THREE distinct LLM slots:
 *
 *   - extraction: which model the memory extractor uses while replaying the
 *     corpus. Production defaults to the fast tier (Haiku-class); for the
 *     bench we want the best extractor we'd actually consider deploying.
 *   - answerer:   the constrained QA model that produces a candidate answer
 *     from the retrieved memories.
 *   - judge:      the LLM grader that scores the answer against the gold.
 *
 * Each slot resolves a TIER (fast | main | escalation), not a hard-coded
 * model id. Tiers map onto the live DB catalog via getFastModel(),
 * getMainModel(), getEscalationModel(), which means when the team swaps
 * "main" from Sonnet-4.6 to Sonnet-5 the bench picks it up automatically.
 * Cross-run comparability is preserved by recording the resolved model id
 * on every bench_runs row.
 *
 * Defaults (good quality, not too pricey):
 *   extraction = main         → Sonnet-class
 *   answerer   = main         → Sonnet-class
 *   judge      = escalation   → Opus-class
 *
 * Three escape hatches:
 *   * CLI:  --extraction-model=<id>  --answerer-model=<id>  --judge-model=<id>
 *   * Env:  AURA_BENCH_EXTRACTION    AURA_BENCH_ANSWERER    AURA_BENCH_JUDGE
 *           (either a tier name or a full gateway-style id)
 *   * Code: pass explicit ids in BenchRunConfig
 *
 * An explicit gateway id always wins. A tier name resolves through the
 * catalog. Missing = use the per-slot default tier.
 */

import { gateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import {
  getFastModel,
  getFastModelId,
  getMainModel,
  getMainModelId,
  getEscalationModel,
  withAnthropicFallback,
} from "../../src/lib/ai.js";

export type ModelTier = "fast" | "main" | "escalation";

const TIER_NAMES: ReadonlySet<string> = new Set(["fast", "main", "escalation"]);

interface ResolvedModel {
  /** AI SDK LanguageModel ready to pass to generateText/generateObject. */
  model: LanguageModel;
  /** Gateway-style id (e.g. anthropic/claude-sonnet-4.6) recorded with the run. */
  modelId: string;
}

async function resolveTier(tier: ModelTier): Promise<ResolvedModel> {
  if (tier === "fast") {
    return {
      model: await getFastModel(),
      modelId: await getFastModelId(),
    };
  }
  if (tier === "escalation") {
    const { model, modelId } = await getEscalationModel();
    return { model, modelId };
  }
  const { model, modelId } = await getMainModel();
  return { model, modelId };
}

function looksLikeModelId(s: string): boolean {
  return s.includes("/");
}

/**
 * Resolve a slot. Priority:
 *   override (explicit gateway id)  >  tier name  >  default tier.
 * The override and the env-var slot accept either a gateway id (returned as-is
 * and wrapped with Anthropic fallback) or a tier name (resolved through the
 * catalog).
 */
async function resolveSlot(
  override: string | undefined,
  envValue: string | undefined,
  defaultTier: ModelTier,
): Promise<ResolvedModel> {
  const raw = (override ?? envValue ?? defaultTier).trim();
  if (looksLikeModelId(raw)) {
    return { model: withAnthropicFallback(gateway(raw), raw), modelId: raw };
  }
  const tier = (TIER_NAMES.has(raw) ? (raw as ModelTier) : defaultTier);
  return resolveTier(tier);
}

export async function resolveBenchExtractionModel(
  override?: string,
): Promise<ResolvedModel> {
  return resolveSlot(override, process.env.AURA_BENCH_EXTRACTION, "main");
}

export async function resolveBenchAnswererModel(
  override?: string,
): Promise<ResolvedModel> {
  return resolveSlot(override, process.env.AURA_BENCH_ANSWERER, "main");
}

export async function resolveBenchJudgeModel(
  override?: string,
): Promise<ResolvedModel> {
  return resolveSlot(override, process.env.AURA_BENCH_JUDGE, "escalation");
}

/**
 * Resolve all three slot model ids without instantiating the LanguageModel.
 * Used by the orchestrator to persist what the run actually used.
 */
export async function resolveBenchRunModelIds(overrides: {
  extraction?: string;
  answerer?: string;
  judge?: string;
}): Promise<{ extraction: string; answerer: string; judge: string }> {
  const idOnly = async (
    override: string | undefined,
    envValue: string | undefined,
    defaultTier: ModelTier,
  ) => {
    const raw = (override ?? envValue ?? defaultTier).trim();
    if (looksLikeModelId(raw)) return raw;
    const tier = TIER_NAMES.has(raw) ? (raw as ModelTier) : defaultTier;
    if (tier === "fast") return getFastModelId();
    if (tier === "escalation") return (await getEscalationModel()).modelId;
    return getMainModelId();
  };
  const [extraction, answerer, judge] = await Promise.all([
    idOnly(overrides.extraction, process.env.AURA_BENCH_EXTRACTION, "main"),
    idOnly(overrides.answerer, process.env.AURA_BENCH_ANSWERER, "main"),
    idOnly(overrides.judge, process.env.AURA_BENCH_JUDGE, "escalation"),
  ]);
  return { extraction, answerer, judge };
}

/** Sentinel exported for tests. */
export const DEFAULT_TIERS = {
  extraction: "main" as ModelTier,
  answerer: "main" as ModelTier,
  judge: "escalation" as ModelTier,
};
