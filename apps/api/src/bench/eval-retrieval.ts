import { retrieveMemories } from "../memory/retrieve.js";
import type { Memory } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import type { BenchCase } from "./types.js";

const DEFAULT_K = 15;

export type RetrievalEvalResult = {
  retrieved: Memory[];
  hit: boolean | null;
};

export async function evaluateRetrieval(
  benchCase: BenchCase,
  workspaceId: string,
  k = DEFAULT_K,
): Promise<RetrievalEvalResult> {
  let retrieved: Memory[] = [];
  try {
    retrieved = await retrieveMemories({
      query: benchCase.question,
      currentUserId: `bench:${benchCase.id}:user`,
      workspaceId,
      limit: k,
      adminMode: true,
    });
  } catch (error) {
    logger.warn("bench: retrieval failed", {
      caseId: benchCase.id,
      error: String(error).slice(0, 200),
    });
  }

  const hasEvidence =
    (benchCase.evidenceDiaIds?.length ?? 0) > 0 ||
    (benchCase.evidenceSessionIds?.length ?? 0) > 0;

  if (benchCase.abstention || !hasEvidence) {
    return { retrieved, hit: null };
  }

  const wantDia = new Set(benchCase.evidenceDiaIds ?? []);
  const wantSession = new Set(benchCase.evidenceSessionIds ?? []);

  for (const mem of retrieved) {
    const prov = mem.benchProvenance;
    if (!prov) {
      if (mem.sourceThreadTs && wantSession.has(mem.sourceThreadTs)) {
        return { retrieved, hit: true };
      }
      continue;
    }
    if (prov.diaIds?.some((d) => wantDia.has(d))) return { retrieved, hit: true };
    if (prov.sessionIds?.some((s) => wantSession.has(s))) return { retrieved, hit: true };
  }

  return { retrieved, hit: false };
}
