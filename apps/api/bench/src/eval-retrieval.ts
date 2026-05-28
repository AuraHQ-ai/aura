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
 * has no evidence pointers — those questions are scored on QA accuracy only.
 *
 * Hit semantics: a hit means at least one retrieved memory has provenance
 * that overlaps with the case's evidence. We accept either dia_id OR
 * session_id overlap, since LongMemEval has session-level evidence but
 * LoCoMo has turn-level.
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
    });
  } catch (error) {
    logger.warn("bench: retrieval failed", {
      caseId: benchCase.id,
      error: String(error).slice(0, 200),
    });
  }

  const retrievedMemoryIds = retrieved.map((m) => m.id);
  const hasEvidence =
    (benchCase.evidenceDiaIds?.length ?? 0) > 0 ||
    (benchCase.evidenceSessionIds?.length ?? 0) > 0;

  if (benchCase.abstention) {
    // For abstention cases, recall is unusual: "no relevant memory" is
    // actually the right answer. Score abstention via QA, not recall.
    return { retrievedMemoryIds, retrieved, hit: null };
  }

  if (!hasEvidence) {
    return { retrievedMemoryIds, retrieved, hit: null };
  }

  const wantDia = new Set(benchCase.evidenceDiaIds ?? []);
  const wantSession = new Set(benchCase.evidenceSessionIds ?? []);

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
