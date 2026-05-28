import { retrieveMemories } from "../../src/memory/retrieve.js";
import type { Memory } from "@aura/db/schema";
import type { BenchCase, BenchCaseResult } from "./types.js";

function provenanceDiaIds(memory: Memory): string[] {
  const provenance = memory.benchProvenance;
  if (!provenance || typeof provenance !== "object") return [];
  const diaIds = (provenance as { diaIds?: unknown }).diaIds;
  return Array.isArray(diaIds) ? diaIds.filter((id): id is string => typeof id === "string") : [];
}

export async function evaluateRetrievalCase(
  benchCase: BenchCase,
  workspaceId: string,
  limit = 15,
): Promise<{ result: BenchCaseResult; memories: Memory[] }> {
  const memories = await retrieveMemories({
    query: benchCase.question,
    currentUserId: "bench:user",
    workspaceId,
    adminMode: true,
    limit,
  });

  const evidence = new Set(benchCase.evidenceDiaIds ?? []);
  const retrievalHit = evidence.size === 0
    ? null
    : memories.some((memory) => provenanceDiaIds(memory).some((diaId) => evidence.has(diaId)));

  return {
    result: {
      caseId: benchCase.id,
      dataset: benchCase.source,
      category: benchCase.category,
      retrievedMemoryIds: memories.map((memory) => memory.id),
      retrievalHit,
      abstention: benchCase.abstention,
    },
    memories,
  };
}
