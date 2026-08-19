/**
 * End-to-end cost accumulator for a bench run.
 *
 * Stages report `(modelId, usage)` as LLM calls complete; the meter converts
 * each to USD via [cost-calculator](../../src/lib/cost-calculator.ts) +
 * the `model_pricing` table and keeps a running per-stage and grand total.
 *
 * Pricing is looked up against the `default` workspace (the bench workspace
 * has no pricing rows). If the bench Neon branch lacks `model_pricing` rows
 * the prices resolve to 0 and cost simply shows ~$0 — accuracy requires those
 * rows to be seeded, but the meter never throws.
 *
 * `record` is async (it may hit the DB on a pricing cache miss) but is designed
 * to be fire-and-forgotten: token counts update synchronously and the USD total
 * lands shortly after. The dashboard polls `snapshot()`; small lag is fine.
 */

import type { DetailedTokenUsage } from "@aura/db/schema";
import { computeConversationCost } from "../../src/lib/cost-calculator.js";

export type CostStage = "extract" | "answer" | "judge" | "retrieve";

const STAGES: CostStage[] = ["extract", "answer", "judge", "retrieve"];

export interface StageCost {
  usd: number;
  tokens: number;
  calls: number;
}

export interface CostSnapshot {
  usd: number;
  tokens: number;
  byStage: Record<CostStage, StageCost>;
}

/** Minimal structural usage shape (AI SDK `result.usage` is assignable). */
export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: DetailedTokenUsage["inputTokenDetails"];
  outputTokenDetails?: DetailedTokenUsage["outputTokenDetails"];
}

export interface CostMeter {
  /** Record one LLM call's usage. Fire-and-forget friendly. */
  record(stage: CostStage, modelId: string, usage: UsageLike): Promise<void>;
  /** Current cumulative totals (cheap; safe to call every render). */
  snapshot(): CostSnapshot;
}

function emptyByStage(): Record<CostStage, StageCost> {
  return STAGES.reduce(
    (acc, s) => {
      acc[s] = { usd: 0, tokens: 0, calls: 0 };
      return acc;
    },
    {} as Record<CostStage, StageCost>,
  );
}

export function createCostMeter(pricingWorkspaceId = "default"): CostMeter {
  const byStage = emptyByStage();
  let usd = 0;
  let tokens = 0;

  return {
    async record(stage, modelId, usage) {
      const t =
        usage.totalTokens ??
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      tokens += t;
      byStage[stage].tokens += t;
      byStage[stage].calls += 1;

      const detailed: DetailedTokenUsage = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: t,
        ...(usage.inputTokenDetails && {
          inputTokenDetails: usage.inputTokenDetails,
        }),
        ...(usage.outputTokenDetails && {
          outputTokenDetails: usage.outputTokenDetails,
        }),
      };

      // Non-fatal: computeConversationCost swallows per-step errors and a
      // missing pricing row simply yields 0.
      const cost = await computeConversationCost(
        [{ modelId, usage: detailed }],
        new Date(),
        pricingWorkspaceId,
      );
      usd += cost;
      byStage[stage].usd += cost;
    },
    snapshot() {
      return {
        usd,
        tokens,
        byStage: STAGES.reduce(
          (acc, s) => {
            acc[s] = { ...byStage[s] };
            return acc;
          },
          {} as Record<CostStage, StageCost>,
        ),
      };
    },
  };
}
