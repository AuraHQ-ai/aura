/**
 * Corpus loaders for the memory bench harness.
 *
 * Each loader returns a normalized `BenchCase[]`. The runner consumes that
 * shape and is dataset-agnostic — adding a new corpus is "write a loader,
 * add a manifest entry".
 *
 * Loaders are tolerant of missing files (returns []), so the harness can
 * still produce a partial score when e.g. the LoCoMo subset is absent for
 * licensing reasons.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { BenchCase, DatasetId } from "./types.js";
import { logger } from "../../src/lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(__dirname, "../corpus");

interface ManifestEntry {
  file: string;
  license: string;
  source: string | null;
  license_url: string | null;
  questions: number;
  vendored?: boolean;
  notes?: string;
  subset_seed?: number;
  subset_axes?: string[];
  subset_categories?: string[];
}

interface Manifest {
  version: number;
  datasets: Record<string, ManifestEntry>;
}

let cachedManifest: Manifest | null = null;
async function loadManifest(): Promise<Manifest> {
  if (cachedManifest) return cachedManifest;
  const text = await readFile(resolve(CORPUS_DIR, "manifest.json"), "utf8");
  cachedManifest = JSON.parse(text) as Manifest;
  return cachedManifest;
}

/** Resolve the on-disk path for a corpus file, or null if it isn't vendored. */
async function corpusPath(datasetId: string): Promise<string | null> {
  const manifest = await loadManifest();
  const entry = manifest.datasets[datasetId];
  if (!entry) return null;
  const fullPath = resolve(CORPUS_DIR, entry.file);
  return existsSync(fullPath) ? fullPath : null;
}

/**
 * SHA-256 hash of the concatenated bytes of every loaded corpus file plus
 * the manifest. Two runs see the same hash iff they replayed identical inputs.
 * Stored on `bench_runs.corpus_hash` so deltas are honest.
 */
export async function computeCorpusHash(datasetIds: DatasetId[]): Promise<string> {
  const hash = createHash("sha256");
  const manifestText = await readFile(resolve(CORPUS_DIR, "manifest.json"), "utf8");
  hash.update("manifest:");
  hash.update(manifestText);
  for (const id of [...datasetIds].sort()) {
    const path = await corpusPath(id);
    if (!path) continue;
    hash.update(`\n${id}:`);
    hash.update(await readFile(path));
  }
  return hash.digest("hex").slice(0, 16);
}

// ── Toy corpus ──────────────────────────────────────────────────────────────

interface ToyCorpus {
  id: string;
  cases: Array<{
    id: string;
    category: string;
    question: string;
    goldAnswer: string | string[];
    abstention: boolean;
    evidenceSessionIds?: string[];
    evidenceDiaIds?: string[];
    sessions: Array<{
      id: string;
      timestamp: string;
      turns: Array<{
        diaId?: string;
        role: "user" | "assistant";
        speaker?: string;
        content: string;
      }>;
    }>;
  }>;
}

export async function loadToyCorpus(): Promise<BenchCase[]> {
  const path = await corpusPath("toy");
  if (!path) {
    logger.warn("Toy corpus missing — should never happen");
    return [];
  }
  const data = JSON.parse(await readFile(path, "utf8")) as ToyCorpus;
  return data.cases.map((c) => ({
    id: c.id,
    source: "toy" as const,
    category: c.category,
    question: c.question,
    goldAnswer: c.goldAnswer,
    abstention: c.abstention,
    sessions: c.sessions.map((s) => ({
      id: s.id,
      timestamp: s.timestamp,
      turns: s.turns.map((t, i) => ({
        diaId: t.diaId ?? `${s.id}:${i + 1}`,
        role: t.role,
        speaker: t.speaker,
        content: t.content,
      })),
    })),
    evidenceSessionIds: c.evidenceSessionIds,
    evidenceDiaIds: c.evidenceDiaIds,
  }));
}

// ── LongMemEval loader ─────────────────────────────────────────────────────
//
// LongMemEval's oracle file is a JSON array of question objects with the
// shape:
//   {
//     "question_id": "...",
//     "question_type": "temporal-reasoning" | "knowledge-update" | "abstention" | ...,
//     "question": "...",
//     "answer": "...",
//     "haystack_session_ids": ["session_2024_01_05", ...],
//     "haystack_sessions": [ [ { "role": "...", "content": "..." } ], ... ],
//     "answer_session_ids": ["session_2024_01_05"]
//   }
// We collapse to our normalized shape. The vendored slice may rename fields
// for readability — the loader tolerates both spellings.

interface LongMemEvalRecord {
  question_id?: string;
  id?: string;
  question_type?: string;
  category?: string;
  question: string;
  answer?: string | string[];
  goldAnswer?: string | string[];
  abstention?: boolean;
  haystack_session_ids?: string[];
  haystack_dates?: string[];
  haystack_sessions?: Array<Array<{ role: string; content: string }>>;
  answer_session_ids?: string[];
  sessions?: Array<{
    id?: string;
    timestamp?: string;
    turns: Array<{ role: string; content: string; speaker?: string }>;
  }>;
}

export async function loadLongMemEval(): Promise<BenchCase[]> {
  const path = await corpusPath("longmemeval");
  if (!path) {
    logger.warn("LongMemEval subset not present — run bench/scripts/fetch-longmemeval.ts to vendor it.");
    return [];
  }
  const records = JSON.parse(await readFile(path, "utf8")) as LongMemEvalRecord[];

  return records.map((r, idx): BenchCase => {
    const id = r.question_id ?? r.id ?? `lme-${idx}`;
    const category = r.category ?? r.question_type ?? "unknown";
    const goldAnswer = r.goldAnswer ?? r.answer ?? "";
    const abstention =
      r.abstention ?? (category === "abstention" || category === "abstain");

    const sessions =
      r.sessions ??
      (r.haystack_sessions ?? []).map((turns, i) => ({
        id: r.haystack_session_ids?.[i] ?? `s${i}`,
        timestamp: r.haystack_dates?.[i] ?? "2024-01-01T00:00:00Z",
        turns,
      }));

    return {
      id,
      source: "longmemeval",
      category,
      question: r.question,
      goldAnswer,
      abstention,
      sessions: sessions.map((s) => ({
        id: s.id ?? "s",
        timestamp: s.timestamp ?? "2024-01-01T00:00:00Z",
        turns: s.turns.map((t, i) => ({
          diaId: `${s.id ?? "s"}:${i + 1}`,
          role:
            t.role === "assistant" || t.role === "bot" || t.role === "ai"
              ? "assistant"
              : "user",
          speaker: (t as any).speaker,
          content: t.content,
        })),
      })),
      evidenceSessionIds: r.answer_session_ids,
    };
  });
}

// ── LoCoMo loader ──────────────────────────────────────────────────────────
//
// LoCoMo ships a per-conversation JSON with multi-session arrays and
// question objects that reference evidence by `dia_id` like "D1:3".
// Format reference: https://github.com/snap-research/locomo
//
// File on disk is OPTIONAL — see corpus/README.md for the licensing caveat.

interface LoCoMoQuestion {
  question: string;
  answer?: string | string[];
  category?: number | string;
  evidence?: string[];
  adversarial_answer?: string | null;
}

interface LoCoMoConversation {
  conversation_id?: string;
  speaker_a?: string;
  speaker_b?: string;
  sessions: Record<
    string,
    Array<{ dia_id?: string; speaker: string; text: string; timestamp?: string }>
  > & { dates?: Record<string, string> };
  questions: LoCoMoQuestion[];
}

// LoCoMo's numeric category codes mapped to readable names. Source:
// snap-research/locomo task_eval/eval_qa.py.
const LOCOMO_CATEGORY_NAMES: Record<string, string> = {
  "1": "single_hop",
  "2": "multi_hop",
  "3": "temporal",
  "4": "open_domain",
  "5": "adversarial",
};

export async function loadLoCoMo(): Promise<BenchCase[]> {
  const path = await corpusPath("locomo");
  if (!path) {
    logger.info("LoCoMo subset not vendored (license decision pending). Skipping.");
    return [];
  }

  const raw = JSON.parse(await readFile(path, "utf8"));
  const conversations: LoCoMoConversation[] = Array.isArray(raw) ? raw : [raw];

  const cases: BenchCase[] = [];
  for (const conv of conversations) {
    const conversationId = conv.conversation_id ?? "conv";
    const sessionEntries = Object.entries(conv.sessions).filter(
      ([k]) => k !== "dates",
    ) as [string, Array<{ dia_id?: string; speaker: string; text: string }>][];

    // Map a → user, b → assistant. Two-humans-as-users is feasible but
    // would require touching the extractor (see #1043 §3).
    const speakerA = conv.speaker_a ?? "A";
    const speakerB = conv.speaker_b ?? "B";

    const sessions = sessionEntries.map(([id, turns], idx) => ({
      id,
      timestamp:
        (conv.sessions as any).dates?.[id] ??
        new Date(2024, 0, 1 + idx).toISOString(),
      turns: turns.map((t, i) => ({
        diaId: t.dia_id ?? `${id}:${i + 1}`,
        role:
          t.speaker === speakerA ? ("user" as const) : ("assistant" as const),
        speaker: t.speaker,
        content: t.text,
      })),
    }));

    for (const [qIdx, q] of conv.questions.entries()) {
      const categoryKey = String(q.category ?? "");
      const category = LOCOMO_CATEGORY_NAMES[categoryKey] ?? `cat_${categoryKey}`;
      const goldAnswer = q.answer ?? q.adversarial_answer ?? "";
      const abstention =
        category === "adversarial" && (goldAnswer === null || goldAnswer === "");
      const evidenceDiaIds = q.evidence ?? [];
      const evidenceSessionIds = [
        ...new Set(evidenceDiaIds.map((d) => d.split(":")[0])),
      ];

      cases.push({
        id: `${conversationId}-q${qIdx}`,
        source: "locomo",
        category,
        question: q.question,
        goldAnswer,
        abstention,
        sessions,
        evidenceSessionIds,
        evidenceDiaIds,
      });
    }
  }
  return cases;
}

// ── Public entry ───────────────────────────────────────────────────────────

export async function loadDataset(id: DatasetId): Promise<BenchCase[]> {
  switch (id) {
    case "toy":
      return loadToyCorpus();
    case "longmemeval":
      return loadLongMemEval();
    case "locomo":
      return loadLoCoMo();
  }
}

/** Deterministic stratified sampler used by --subset=fast. */
export function sampleFast(cases: BenchCase[], targetPerCategory: number, seed = 4711): BenchCase[] {
  const byCategory = new Map<string, BenchCase[]>();
  for (const c of cases) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category)!.push(c);
  }
  const rng = mulberry32(seed);
  const out: BenchCase[] = [];
  for (const [, list] of byCategory) {
    // Shuffle deterministically then take the first N.
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    out.push(...shuffled.slice(0, targetPerCategory));
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
