"use server";

import { apiGet } from "@/lib/api";

export interface ConsumptionData {
  dailyCost: Array<{ date: string; cost: number; conversations: number }>;
  perUser: Array<{
    userId: string;
    displayName: string | null;
    interactiveCost: number;
    jobCost: number;
    totalCost: number;
    conversations: number;
  }>;
  perJob: Array<{
    jobName: string | null;
    creatorName: string | null;
    executionCount: number;
    totalCost: number;
  }>;
  totals: { totalCost: number; conversations: number; avgDailyCost: number };
  tokenBreakdown: {
    cacheRead: number;
    cacheWrite: number;
    uncached: number;
    output: number;
  };
}

export async function getConsumptionData(): Promise<ConsumptionData> {
  return apiGet<ConsumptionData>("/consumption");
}
