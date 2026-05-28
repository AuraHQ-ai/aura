import { retrieveMemories } from "../../src/memory/retrieve.js";
import type { Memory } from "@aura/db/schema";
import type { BenchCase, BenchCaseResult } from "./types.js";

function provenanceDiaIds(memory: Memory): string[] {
  const provenance = memory.benchProvenance;
  if (!provenance || typeof provenance !== "object") return [];
  const diaIds = (provenance as { diaIds?: unknown }).diaIds;
  return Array.isArray(diaIds) ? diaIds.filter((id): id is string => typeof id === "string") : [];
}

function provenanceSessionIds(memory: Memory): string[] {
  const provenance = memory.benchProvenance;
  if (!provenance || typeof provenance !== "object") return [];
  const single = (provenance as { sessionId?: unknown }).sessionId;
  const many = (provenance as { sessionIds?: unknown }).sessionIds;
  const values = Array.isArray(many) ? many : single ? [single] : [];
  return values.filter((id): id is string => typeof id === "string");
}

function provenanceConversationId(memory: Memory): string | undefined {
  const provenance = memory.benchProvenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  const conversationId = (provenance as { conversationId?: unknown }).conversationId;
  return typeof conversationId === "string" ? conversationId : undefined;
}

function caseConversationId(benchCase: BenchCase): string {
  return benchCase.id.replace(/-q\d+$/i, "");
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

  const evidenceDiaIds = new Set(benchCase.evidenceDiaIds ?? []);
  const evidenceSessionIds = new Set(benchCase.evidenceSessionIds ?? []);
  const expectedConversationId = caseConversationId(benchCase);
  const retrievalHit = benchCase.abstention || (evidenceDiaIds.size === 0 && evidenceSessionIds.size === 0)
    ? null
    : memories.some((memory) => {
      const memoryConversationId = provenanceConversationId(memory);
      if (memoryConversationId && memoryConversationId !== expectedConversationId) return false;
      return (
        provenanceDiaIds(memory).some((diaId) => evidenceDiaIds.has(diaId)) ||
        provenanceSessionIds(memory).some((sessionId) => evidenceSessionIds.has(sessionId))
      );
    });

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
