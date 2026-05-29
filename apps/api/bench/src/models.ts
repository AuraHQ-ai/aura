/**
 * Bench-only model resolution.
 *
 * The bench operates over THREE distinct LLM slots:
 *
 *   - extraction: which model the memory extractor uses while replaying the
 *     corpus. Pinned to the fast tier so the bench mirrors production, where
 *     extractMemories() runs on getFastModel(). Since the bench executes
 *     against a copy of the prod DB, the fast tier resolves to the exact same
 *     model id prod is using (Haiku-class today).
 *   - answerer:   the constrained QA model that produces a candidate answer
 *     from the retrieved memories. Uses the main tier — prod's conversation
 *     model is what reads injected memories and answers, so this matches.
 *   - judge:      the LLM grader that scores the answer against the gold. No
 *     production equivalent (Aura never grades in prod); kept on a strong,
 *     independent tier (escalation) to avoid self-grading bias.
 *
 * Each slot resolves a TIER (fast | main | escalation), not a hard-coded
 * model id. Tiers map onto the live DB catalog via getFastModel(),
 * getMainModel(), getEscalationModel(). Because the bench runs against a copy
 * of the prod DB, this means the bench transparently uses the SAME models prod
 * is using, and keeps tracking them when the team swaps a tier (e.g. "fast"
 * Haiku → Haiku-next). Cross-run comparability is preserved by recording the
 * resolved model id on every bench_runs row.
 *
 * Defaults (chosen to mirror production):
 *   extraction = fast         → matches prod's getFastModel()
 *   answerer   = main         → matches prod's conversation model
 *   judge      = escalation   → strong, independent grader (eval-only)
 *
 * Three escape hatches:
 *   * CLI:  --extraction-model=<id>  --answerer-model=<id>  --judge-model=<id>
 *   * Env:  AURA_BENCH_EXTRACTION    AURA_BENCH_ANSWERER    AURA_BENCH_JUDGE
 *           (either a tier name or a full gateway-style id)
 *   * Code: pass explicit ids in BenchRunConfig
 *
 * Resolution priority per slot:
 *   explicit gateway id  >  tier name  >  per-slot default tier.
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

/**
 * Per-slot default tier, chosen so the bench mirrors production. Each tier
 * resolves through the live DB catalog at run time. Override any slot with a
 * CLI flag / env var (a gateway id or a tier name).
 */
export const DEFAULT_TIERS = {
  extraction: "fast" as ModelTier,
  answerer: "main" as ModelTier,
  judge: "escalation" as ModelTier,
};

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

function resolveModelId(id: string): ResolvedModel {
  return { model: withAnthropicFallback(gateway(id), id), modelId: id };
}

/**
 * Resolve a slot. Priority:
 *   override (explicit gateway id)  >  tier name  >  fallback.
 * The override and the env-var slot accept either a gateway id (returned as-is
 * and wrapped with Anthropic fallback) or a tier name (resolved through the
 * catalog). The fallback is itself a gateway id or a tier name.
 */
async function resolveSlot(
  override: string | undefined,
  envValue: string | undefined,
  fallback: string,
): Promise<ResolvedModel> {
  const raw = (override ?? envValue ?? fallback).trim();
  if (looksLikeModelId(raw)) return resolveModelId(raw);
  if (TIER_NAMES.has(raw)) return resolveTier(raw as ModelTier);
  // Unrecognized override/env value: resolve the fallback (id or tier).
  if (looksLikeModelId(fallback)) return resolveModelId(fallback);
  return resolveTier((TIER_NAMES.has(fallback) ? fallback : "main") as ModelTier);
}

export async function resolveBenchExtractionModel(
  override?: string,
): Promise<ResolvedModel> {
  return resolveSlot(override, process.env.AURA_BENCH_EXTRACTION, DEFAULT_TIERS.extraction);
}

export async function resolveBenchAnswererModel(
  override?: string,
): Promise<ResolvedModel> {
  return resolveSlot(override, process.env.AURA_BENCH_ANSWERER, DEFAULT_TIERS.answerer);
}

export async function resolveBenchJudgeModel(
  override?: string,
): Promise<ResolvedModel> {
  return resolveSlot(override, process.env.AURA_BENCH_JUDGE, DEFAULT_TIERS.judge);
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
    fallback: string,
  ): Promise<string> => {
    const raw = (override ?? envValue ?? fallback).trim();
    const resolveTierId = (tier: ModelTier) => {
      if (tier === "fast") return getFastModelId();
      if (tier === "escalation") return getEscalationModel().then((m) => m.modelId);
      return getMainModelId();
    };
    if (looksLikeModelId(raw)) return raw;
    if (TIER_NAMES.has(raw)) return resolveTierId(raw as ModelTier);
    // Unrecognized override/env value: resolve the fallback (id or tier).
    if (looksLikeModelId(fallback)) return fallback;
    return resolveTierId((TIER_NAMES.has(fallback) ? fallback : "main") as ModelTier);
  };
  const [extraction, answerer, judge] = await Promise.all([
    idOnly(overrides.extraction, process.env.AURA_BENCH_EXTRACTION, DEFAULT_TIERS.extraction),
    idOnly(overrides.answerer, process.env.AURA_BENCH_ANSWERER, DEFAULT_TIERS.answerer),
    idOnly(overrides.judge, process.env.AURA_BENCH_JUDGE, DEFAULT_TIERS.judge),
  ]);
  return { extraction, answerer, judge };
}
