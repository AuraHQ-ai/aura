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
import type { UsageLike } from "./cost-meter.js";

const DEFAULT_K = 15;

export interface RetrievalEvalResult {
  retrievedMemoryIds: string[];
  retrieved: Memory[];
  /**
   * Coverage-based recall: fraction (0..1) of the case's evidence SESSIONS
   * represented in the retrieved set. null when the case has no evidence
   * pointers (can't score recall).
   *
   * This replaces the old binary "any evidence session present" hit, which
   * reported 1.0 for a multi-hop question even when only one of its two
   * evidence sessions was retrieved — masking exactly the failures the QA
   * lane was catching. Coverage drops to 0.5 in that case.
   */
  coverage: number | null;
  /** Distinct evidence sessions represented in the retrieved set. */
  coveredSessions: number;
  /** Total distinct evidence sessions the gold answer cites. */
  evidenceSessions: number;
  /** Convenience: coverage > 0. null when no evidence pointers. */
  hit: boolean | null;
}

/**
 * Score retrieval recall for one case. Returns coverage/hit `null` when the
 * case has no evidence pointers — those questions are scored on QA accuracy
 * only.
 *
 * Coverage semantics: we count how many of the gold-cited evidence sessions
 * are represented by at least one retrieved memory, divided by the total
 * number of evidence sessions. A retrieved memory "represents" a session via
 * any of three channels (union):
 *
 *   1. sourceThreadTs ∈ evidenceSessionIds.
 *      Cheap. Works because bench ingest sets sourceThreadTs = session.id.
 *      Covers LongMemEval where evidence is session-level.
 *   2. bench_provenance.sessionIds ∩ evidenceSessionIds ≠ ∅.
 *   3. bench_provenance.diaIds whose session prefix ∈ evidence sessions, or
 *      that match an evidence dia_id exactly (LoCoMo turn-level pointers).
 */
export async function evaluateRetrieval(
  benchCase: BenchCase,
  workspaceId: string,
  k = DEFAULT_K,
  onUsage?: (modelId: string, usage: UsageLike) => void,
  asOf?: Date,
): Promise<RetrievalEvalResult> {
  let retrieved: Memory[] = [];
  try {
    retrieved = await retrieveMemories({
      query: benchCase.question,
      currentUserId: `bench:${benchCase.id}`,
      limit: k,
      workspaceId,
      adminMode: true,
      rewrite: true,
      onUsage,
      asOf,
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

  // The denominator is the set of distinct evidence sessions. LoCoMo only
  // ships turn-level dia_ids, so fold their session prefixes in too.
  const evidence = new Set<string>(wantSession);
  for (const d of wantDia) evidence.add(d.split(":")[0]);

  const none: RetrievalEvalResult = {
    retrievedMemoryIds,
    retrieved,
    coverage: null,
    coveredSessions: 0,
    evidenceSessions: evidence.size,
    hit: null,
  };

  if (benchCase.abstention) {
    // For abstention cases, recall is unusual: "no relevant memory" is
    // actually the right answer. Score abstention via QA, not recall.
    return none;
  }
  if (evidence.size === 0) return none;

  // Mark every evidence session that at least one retrieved memory represents.
  const covered = new Set<string>();
  const mark = (s: string | null | undefined) => {
    if (s && evidence.has(s)) covered.add(s);
  };
  for (const mem of retrieved) {
    mark(mem.sourceThreadTs);
    const prov = (mem as any).benchProvenance as
      | { diaIds?: string[]; sessionIds?: string[] }
      | null
      | undefined;
    if (prov) {
      prov.sessionIds?.forEach(mark);
      // A dia_id like "D1:3" belongs to session "D1"; mark that session.
      prov.diaIds?.forEach((d) => mark(d.split(":")[0]));
    }
  }

  const coverage = covered.size / evidence.size;
  return {
    retrievedMemoryIds,
    retrieved,
    coverage,
    coveredSessions: covered.size,
    evidenceSessions: evidence.size,
    hit: covered.size > 0,
  };
}
