/**
 * Corpus loaders for the memory bench harness.
 *
 * Each loader returns normalized BenchCase[]. Loaders tolerate missing
 * files (return []) so partial runs work when LoCoMo isn't cached yet.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { BenchCase, BenchDataset, BenchSubset, DatasetId } from "./types.js";
import { CORPUS_DIR } from "./corpus/ensure-corpus.js";
import { logger } from "../lib/logger.js";

interface ManifestEntry {
  file: string;
  vendored?: boolean;
  source?: string;
  fetchUrl?: string;
  questions?: number;
  notes?: string;
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

async function corpusPath(datasetId: string): Promise<string | null> {
  const manifest = await loadManifest();
  const entry = manifest.datasets[datasetId];
  if (!entry) return null;
  const fullPath = resolve(CORPUS_DIR, entry.file);
  if (existsSync(fullPath)) return fullPath;
  if (entry.vendored === false && entry.fetchUrl) {
    logger.warn(
      `bench: ${datasetId} not in cache — run 'pnpm bench:fetch-corpus' first.`,
    );
  }
  return null;
}

export function normalizeDataset(dataset: BenchDataset): DatasetId[] {
  if (dataset === "both") return ["longmemeval", "locomo"];
  if (dataset === "lme") return ["longmemeval"];
  if (dataset === "locomo") return ["locomo"];
  return ["toy"];
}

export async function computeCorpusHash(params: {
  dataset: BenchDataset;
  corpusFile?: string;
}): Promise<string> {
  if (params.corpusFile) {
    const raw = await readFile(resolve(params.corpusFile));
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  const hash = createHash("sha256");
  hash.update(await readFile(resolve(CORPUS_DIR, "manifest.json")));
  for (const datasetId of normalizeDataset(params.dataset).sort()) {
    const path = await corpusPath(datasetId);
    if (!path) continue;
    hash.update(datasetId);
    hash.update(await readFile(path));
  }
  return hash.digest("hex").slice(0, 16);
}

export async function loadBenchCases(params: {
  dataset: BenchDataset;
  subset: BenchSubset;
  category?: string;
  corpusFile?: string;
}): Promise<BenchCase[]> {
  const loadedCases = params.corpusFile
    ? await loadExternalCorpus(params.corpusFile)
    : (await Promise.all(normalizeDataset(params.dataset).map(loadDataset))).flat();

  const allowed = new Set(normalizeDataset(params.dataset));
  const cases = params.corpusFile
    ? loadedCases.filter((c) => allowed.has(c.source))
    : loadedCases;

  const filtered = params.category
    ? cases.filter(
        (c) =>
          c.category === params.category ||
          c.category.replace(/-/g, "_") === params.category,
      )
    : cases;

  const perCategory = SUBSET_PER_CATEGORY[params.subset];
  return Number.isFinite(perCategory)
    ? stratifiedSample(filtered, perCategory, BENCH_SAMPLE_SEED)
    : filtered;
}

async function loadDataset(datasetId: DatasetId): Promise<BenchCase[]> {
  switch (datasetId) {
    case "toy":
      return loadToyCorpus();
    case "longmemeval":
      return loadLongMemEval();
    case "locomo":
      return loadLoCoMo();
  }
}

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
    sessions: BenchCase["sessions"];
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
    turns: Array<{ role: string; content: string; speaker?: string; diaId?: string }>;
  }>;
}

export async function loadLongMemEval(): Promise<BenchCase[]> {
  const path = await corpusPath("longmemeval");
  if (!path) return [];

  const records = JSON.parse(await readFile(path, "utf8")) as LongMemEvalRecord[];

  return records.map((r, idx): BenchCase => {
    const id = r.question_id ?? r.id ?? `lme-${idx}`;
    const category = (r.category ?? r.question_type ?? "unknown").replace(/-/g, "_");
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
        turns: s.turns.map((t, i) => {
          const turn = t as {
            role: string;
            content: string;
            speaker?: string;
            diaId?: string;
          };
          return {
            diaId: turn.diaId ?? `${s.id ?? "s"}:${i + 1}`,
            role:
              turn.role === "assistant" || turn.role === "bot" || turn.role === "ai"
                ? "assistant"
                : "user",
            speaker: turn.speaker,
            content: turn.content,
          };
        }),
      })),
      evidenceSessionIds: r.answer_session_ids,
    };
  });
}

interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

interface LoCoMoQA {
  question: string;
  answer?: string | string[] | null;
  category?: number | string;
  evidence?: string[];
  adversarial_answer?: string | null;
}

interface LoCoMoConversation {
  sample_id?: string;
  qa?: LoCoMoQA[];
  conversation?: Record<string, unknown> & {
    speaker_a?: string;
    speaker_b?: string;
  };
}

const LOCOMO_CATEGORY_NAMES: Record<string, string> = {
  "1": "multi_hop",
  "2": "single_hop",
  "3": "temporal",
  "4": "open_domain",
  "5": "adversarial",
};

function parseLocomoDate(raw: string | undefined, fallbackIdx: number): string {
  if (raw) {
    const cleaned = raw.replace(/\s+on\s+/i, " ").trim();
    const d = new Date(cleaned);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(Date.UTC(2024, 0, 1 + fallbackIdx)).toISOString();
}

export async function loadLoCoMo(): Promise<BenchCase[]> {
  const path = await corpusPath("locomo");
  if (!path) return [];

  const raw = JSON.parse(await readFile(path, "utf8"));
  const conversations: LoCoMoConversation[] = Array.isArray(raw) ? raw : [raw];

  const cases: BenchCase[] = [];
  for (const conv of conversations) {
    const conversation = conv.conversation;
    if (!conversation) continue;

    const conversationId = conv.sample_id ?? "conv";
    const speakerA = conversation.speaker_a ?? "A";

    const sessionKeys = Object.keys(conversation)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));

    const sessions = sessionKeys.map((sessionKey, idx) => {
      const sessionNumber = Number(sessionKey.slice("session_".length));
      const turns = conversation[sessionKey] as LoCoMoTurn[] | undefined;
      const dateRaw = conversation[`${sessionKey}_date_time`] as string | undefined;
      return {
        id: `D${sessionNumber}`,
        timestamp: parseLocomoDate(dateRaw, idx),
        turns: (turns ?? []).map((t, i) => ({
          diaId: t.dia_id ?? `D${sessionNumber}:${i + 1}`,
          role:
            t.speaker === speakerA ? ("user" as const) : ("assistant" as const),
          speaker: t.speaker,
          content: t.text,
        })),
      };
    });

    for (const [qIdx, q] of (conv.qa ?? []).entries()) {
      const categoryKey = String(q.category ?? "");
      const category =
        LOCOMO_CATEGORY_NAMES[categoryKey] ?? `cat_${categoryKey}`;
      const goldAnswer = q.answer ?? q.adversarial_answer ?? "";
      const abstention =
        category === "adversarial" &&
        (goldAnswer === null ||
          goldAnswer === "" ||
          (Array.isArray(goldAnswer) && goldAnswer.length === 0));
      const evidenceDiaIds = q.evidence ?? [];
      const evidenceSessionIds = [
        ...new Set(evidenceDiaIds.map((d) => d.split(":")[0])),
      ];

      cases.push({
        id: `${conversationId}-q${qIdx}`,
        source: "locomo",
        category,
        question: q.question,
        goldAnswer: goldAnswer ?? "",
        abstention,
        sessions,
        evidenceSessionIds,
        evidenceDiaIds,
      });
    }
  }
  return cases;
}

export async function loadExternalCorpus(filePath: string): Promise<BenchCase[]> {
  const abs = resolve(filePath);
  const parsed = JSON.parse(await readFile(abs, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(
      `--corpus-file expects an array of BenchCase, got ${typeof parsed} at ${abs}`,
    );
  }
  return parsed as BenchCase[];
}

/** Stable seed for stratified sampling (issue #1043). */
export const BENCH_SAMPLE_SEED = 1043;

export const SUBSET_PER_CATEGORY: Record<BenchSubset, number> = {
  fast: 4,
  medium: 30,
  full: Number.POSITIVE_INFINITY,
};

export function stratifiedSample(
  cases: BenchCase[],
  targetPerCategory: number,
  seed = BENCH_SAMPLE_SEED,
): BenchCase[] {
  const byCategory = new Map<string, BenchCase[]>();
  for (const c of cases) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category)!.push(c);
  }
  const rng = mulberry32(seed);
  const out: BenchCase[] = [];
  for (const [, list] of byCategory) {
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const cap = Number.isFinite(targetPerCategory) ? targetPerCategory : shuffled.length;
    out.push(...shuffled.slice(0, cap));
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
