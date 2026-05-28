import { embedText } from "../lib/embeddings.js";
import { retrieveMemories } from "../memory/retrieve.js";
import type { BenchCase } from "./types.js";

const RECALL_K = 15;

/**
 * Deterministic retrieval recall@K using corpus evidence session ids
 * (stored as memory sourceThreadTs during bench ingest).
 */
export async function evalRetrievalRecall(
  benchCase: BenchCase,
  workspaceId: string,
): Promise<boolean> {
  const evidence = benchCase.evidenceSessionIds ?? [];
  if (evidence.length === 0) {
    return false;
  }

  const queryEmbedding = await embedText(benchCase.question);
  const retrieved = await retrieveMemories({
    query: benchCase.question,
    queryEmbedding,
    currentUserId: `bench:${benchCase.id}:user`,
    workspaceId,
    limit: RECALL_K,
    adminMode: true,
  });

  const retrievedSessions = new Set(
    retrieved.map((m) => m.sourceThreadTs).filter((s): s is string => !!s),
  );

  return evidence.some((id) => retrievedSessions.has(id));
}
