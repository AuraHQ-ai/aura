import { and, eq, lte, gte, or, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { modelPricing, type DetailedTokenUsage } from "@aura/db/schema";
import { logger } from "./logger.js";

export interface StepUsage {
  modelId: string;
  usage: DetailedTokenUsage;
}

interface PricingRow {
  tokenType: string;
  pricePerMillion: string;
}

const pricingCache = new Map<string, PricingRow[]>();

/**
 * Normalize a model ID for pricing lookup.
 * The AI SDK gateway returns IDs like "anthropic/claude-sonnet-4-20250514"
 * while step.response.modelId may return just "claude-sonnet-4-20250514".
 * We strip the provider prefix and the date suffix for flexible matching.
 */
function normalizeModelId(modelId: string): string[] {
  const stripped = modelId.replace(/^[^/]+\//, "");
  const withoutDate = stripped.replace(/-\d{8}$/, "");
  const candidates = [modelId, stripped, withoutDate];
  if (modelId.includes("/")) {
    const prefix = modelId.split("/")[0];
    candidates.push(`${prefix}/${withoutDate}`);
  }
  return [...new Set(candidates)];
}

async function lookupPricing(
  modelId: string,
  asOfDate: Date,
): Promise<PricingRow[]> {
  const cacheKey = `${modelId}:${asOfDate.toISOString().slice(0, 10)}`;
  if (pricingCache.has(cacheKey)) return pricingCache.get(cacheKey)!;

  const candidates = normalizeModelId(modelId);

  for (const candidate of candidates) {
    const rows = await db
      .select({
        tokenType: modelPricing.tokenType,
        pricePerMillion: modelPricing.pricePerMillion,
      })
      .from(modelPricing)
      .where(
        and(
          eq(modelPricing.modelId, candidate),
          lte(modelPricing.effectiveFrom, asOfDate),
          or(
            isNull(modelPricing.effectiveUntil),
            gte(modelPricing.effectiveUntil, asOfDate),
          ),
        ),
      );

    if (rows.length > 0) {
      pricingCache.set(cacheKey, rows);
      return rows;
    }
  }

  pricingCache.set(cacheKey, []);
  return [];
}

function getPrice(
  rows: PricingRow[],
  tokenType: string,
): number {
  const row = rows.find((r) => r.tokenType === tokenType);
  return row ? parseFloat(row.pricePerMillion) : 0;
}

/**
 * Compute cost for a single step's usage given its pricing rows.
 */
function computeStepCost(
  usage: DetailedTokenUsage,
  pricing: PricingRow[],
): number {
  if (pricing.length === 0) return 0;

  const inputPrice = getPrice(pricing, "input");
  const cacheReadPrice = getPrice(pricing, "cache_read");
  const cacheWritePrice = getPrice(pricing, "cache_write");
  const outputPrice = getPrice(pricing, "output");
  const reasoningPrice = getPrice(pricing, "reasoning");

  let inputCost: number;
  if (usage.inputTokenDetails) {
    const noCacheTokens = usage.inputTokenDetails.noCacheTokens ?? 0;
    const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
    inputCost =
      (noCacheTokens * inputPrice +
        cacheReadTokens * cacheReadPrice +
        cacheWriteTokens * cacheWritePrice) /
      1_000_000;
  } else {
    inputCost = ((usage.inputTokens ?? 0) * inputPrice) / 1_000_000;
  }

  let outputCost: number;
  if (usage.outputTokenDetails) {
    const textTokens = usage.outputTokenDetails.textTokens ?? 0;
    const reasoningTokens = usage.outputTokenDetails.reasoningTokens ?? 0;
    outputCost =
      (textTokens * outputPrice + reasoningTokens * reasoningPrice) /
      1_000_000;
  } else {
    outputCost = ((usage.outputTokens ?? 0) * outputPrice) / 1_000_000;
  }

  return inputCost + outputCost;
}

/**
 * Build per-step usage data from raw AI SDK steps.
 * Filters to steps that have both a modelId and usage, then maps to StepUsage[].
 */
export function buildStepUsages(rawSteps: any[]): StepUsage[] {
  return rawSteps
    .filter((step: any) => step.response?.modelId && step.usage)
    .map((step: any) => ({
      modelId: step.response.modelId,
      usage: {
        inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0,
        totalTokens: step.usage.totalTokens ?? 0,
        inputTokenDetails: step.usage.inputTokenDetails,
        outputTokenDetails: step.usage.outputTokenDetails,
      },
    }));
}

/**
 * Compute total cost in USD for an array of steps.
 * Looks up pricing for each model and computes:
 *   Σ (token_count × price_per_million / 1_000_000) across all token types per step.
 */
export async function computeConversationCost(
  steps: StepUsage[],
  asOfDate: Date = new Date(),
): Promise<number> {
  let totalCost = 0;

  for (const step of steps) {
    try {
      const pricing = await lookupPricing(step.modelId, asOfDate);
      totalCost += computeStepCost(step.usage, pricing);
    } catch (err: any) {
      logger.warn("Cost calculation failed for step (non-fatal)", {
        modelId: step.modelId,
        error: err.message,
      });
    }
  }

  return totalCost;
}
