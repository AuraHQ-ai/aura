/**
 * Deterministic retrieval recall@K scorer.
 *
 * For each BenchCase that ships with evidence pointers (LoCoMo `dia_ids`,
 * LongMemEval `answer_session_ids`), we call the real retriever and check
 * whether ANY returned memory covers ANY evidence pointer. Coverage is
 * computed via the `bench_provenance` JSONB column we stamp during ingest.
 *
 * No LLM, no judge — the signal is cheap and exactly diagnostic for
 * #1038 (query weighting) and #1044 (retrieval changes) without needing
 * to disentangle extractor regressions from retriever regressions.
 */

import { retrieveMemories } from "../../src/memory/retrieve.js";
import type { Memory } from "@aura/db/schema";
import { logger } from "../../src/lib/logger.js";
import type { BenchCase } from "./types.js";

const DEFAULT_K = 15;

export interface RetrievalEvalResult {
  retrievedMemoryIds: string[];
  retrieved: Memory[];
  /** null when the case has no evidence pointers (can't score recall). */
  hit: boolean | null;
}

/**
 * Score retrieval recall for one case. Returns `hit=null` when the case
 * has no evidence pointers — those questions are scored on QA accuracy
 * only.
 *
 * Hit semantics: a hit means at least one retrieved memory came from a
 * session the gold answer cites. We check two channels and take the
 * union so the scorer works for both corpora:
 *
 *   1. sourceThreadTs ∈ evidenceSessionIds.
 *      Cheap. Works because bench ingest sets sourceThreadTs = session.id.
 *      Covers LongMemEval where evidence is session-level.
 *   2. bench_provenance.diaIds ∩ evidenceDiaIds ≠ ∅, or
 *      bench_provenance.sessionIds ∩ evidenceSessionIds ≠ ∅.
 *      Fallback for cases where (1) misses — and the route to
 *      dia_id-granular recall once we want it.
 */
export async function evaluateRetrieval(
  benchCase: BenchCase,
  workspaceId: string,
  k = DEFAULT_K,
): Promise<RetrievalEvalResult> {
  let retrieved: Memory[] = [];
  try {
    retrieved = await retrieveMemories({
      query: benchCase.question,
      currentUserId: `bench:${benchCase.id}`,
      limit: k,
      workspaceId,
      adminMode: true,
      prefilter: true,
    });
  } catch (error) {
    logger.warn("bench: retrieval failed", {
      caseId: benchCase.id,
      error: String(error).slice(0, 200),
    });
  }

  const retrievedMemoryIds = retrieved.map((m) => m.id);
  const wantDia = new Set(benchCase.evidenceDiaIds ?? []);
  const wantSession = new Set(benchCase.evidenceSessionIds ?? []);
  const hasEvidence = wantDia.size > 0 || wantSession.size > 0;

  if (benchCase.abstention) {
    // For abstention cases, recall is unusual: "no relevant memory" is
    // actually the right answer. Score abstention via QA, not recall.
    return { retrievedMemoryIds, retrieved, hit: null };
  }
  if (!hasEvidence) {
    return { retrievedMemoryIds, retrieved, hit: null };
  }

  // Channel 1 — sourceThreadTs (the simple session-level check)
  if (wantSession.size > 0) {
    for (const mem of retrieved) {
      if (mem.sourceThreadTs && wantSession.has(mem.sourceThreadTs)) {
        return { retrievedMemoryIds, retrieved, hit: true };
      }
    }
  }

  // Channel 2 — bench_provenance for fine-grained matching
  for (const mem of retrieved) {
    const prov = (mem as any).benchProvenance as
      | { diaIds?: string[]; sessionIds?: string[] }
      | null
      | undefined;
    if (!prov) continue;
    if (prov.diaIds?.some((d) => wantDia.has(d))) {
      return { retrievedMemoryIds, retrieved, hit: true };
    }
    if (prov.sessionIds?.some((s) => wantSession.has(s))) {
      return { retrievedMemoryIds, retrieved, hit: true };
    }
  }
  return { retrievedMemoryIds, retrieved, hit: false };
}
