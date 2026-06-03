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
  vendored?: boolean;
  source?: string;
  fetchUrl?: string;
  fallbackUrl?: string;
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

/** Resolve the on-disk path for a corpus file, or null if it isn't available. */
async function corpusPath(datasetId: string): Promise<string | null> {
  const manifest = await loadManifest();
  const entry = manifest.datasets[datasetId];
  if (!entry) return null;
  const fullPath = resolve(CORPUS_DIR, entry.file);
  if (existsSync(fullPath)) return fullPath;
  if (entry.vendored === false && entry.fetchUrl) {
    logger.warn(
      `bench: ${datasetId} not in cache — run 'pnpm bench:fetch-corpus' first. (Source: ${entry.source ?? entry.fetchUrl})`,
    );
  }
  return null;
}

/**
 * SHA-256 hash of the concatenated bytes of every loaded corpus file plus
 * the manifest. Two runs see the same hash iff they replayed identical inputs.
 * Stored on `bench_runs.corpus_hash` so deltas are honest.
 */
export async function computeCorpusHash(
  datasetIds: DatasetId[],
  corpusFile?: string,
): Promise<string> {
  const hash = createHash("sha256");
  if (corpusFile) {
    hash.update("file:");
    hash.update(resolve(corpusFile));
    hash.update("\n");
    hash.update(await readFile(resolve(corpusFile)));
    return hash.digest("hex").slice(0, 16);
  }
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
    questionDate?: string;
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
    questionDate: c.questionDate,
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
  /** Reference "now" for the question, e.g. "2023/04/10 (Mon) 23:07". */
  question_date?: string;
  questionDate?: string;
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
      questionDate: r.questionDate ?? r.question_date,
    };
  });
}

// ── LoCoMo loader ──────────────────────────────────────────────────────────
//
// LoCoMo's locomo10.json is a top-level array of 10 conversations. Each
// conversation looks like:
//
//   {
//     "sample_id": "conv-26",
//     "qa": [
//       { "question": "...", "answer": "...", "evidence": ["D1:3"], "category": 2 },
//       ...
//     ],
//     "conversation": {
//       "speaker_a": "Caroline",
//       "speaker_b": "Melanie",
//       "session_1_date_time": "1:56 pm on 8 May, 2023",
//       "session_1": [ { "speaker": "Caroline", "dia_id": "D1:1", "text": "..." }, ... ],
//       "session_2_date_time": "...",
//       "session_2": [ ... ],
//       ...
//     }
//   }
//
// `dia_id` is shaped "D{session_number}:{turn_number}". Evidence pointers
// in the qa entries use the same convention. We map session_N → ID "DN"
// so the evidence pointers and `evidenceSessionIds` align.

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

// LoCoMo numeric category codes → readable names. Source:
// snap-research/locomo task_eval/eval_qa.py.
const LOCOMO_CATEGORY_NAMES: Record<string, string> = {
  "1": "multi_hop",
  "2": "single_hop",
  "3": "temporal",
  "4": "open_domain",
  "5": "adversarial",
};

/**
 * Parse LoCoMo's free-form session dates ("1:56 pm on 8 May, 2023") into
 * an ISO 8601 timestamp. JavaScript's Date constructor handles most
 * variants; we strip the leading "X:XX am/pm on " when present, then fall
 * back to a midnight ISO if parsing fails.
 */
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

    // Pair every "session_N" array with its "session_N_date_time" sibling.
    const sessionKeys = Object.keys(conversation)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));

    const sessions = sessionKeys.map((sessionKey, idx) => {
      const sessionNumber = Number(sessionKey.slice("session_".length));
      const turns = conversation[sessionKey] as LoCoMoTurn[] | undefined;
      const dateRaw = conversation[`${sessionKey}_date_time`] as string | undefined;
      return {
        // Map session_3 → "D3" so evidence dia_ids like "D3:5" match.
        id: `D${sessionNumber}`,
        timestamp: parseLocomoDate(dateRaw, idx),
        turns: (turns ?? []).map((t, i) => ({
          diaId: t.dia_id ?? `D${sessionNumber}:${i + 1}`,
          // LoCoMo is a HUMAN↔HUMAN dialog — neither speaker is Aura. The old
          // mapping (speaker_b → assistant) made the extractor file speaker_b's
          // self-statements as facts about Aura (e.g. "Melanie likes Bach and
          // Mozart" → "Aura is a fan of Bach and Mozart"), so ~40% of memories
          // got entangled with the assistant identity and questions about that
          // speaker became unanswerable. Both speakers are distinct named USERS
          // (the `speaker` field carries the name), mirroring how prod ingests a
          // multi-person channel where Aura is not the one talking. With no
          // assistant turns, the exchange cadence falls back to one reconciliation
          // pass per session (sessions are ≤47 turns, within the 30-turn / 12k-char
          // window), so attribution is correct without losing context.
          role: "user" as const,
          speaker: t.speaker,
          content: t.text,
        })),
      };
    });

    for (const [qIdx, q] of (conv.qa ?? []).entries()) {
      const categoryKey = String(q.category ?? "");
      const category =
        LOCOMO_CATEGORY_NAMES[categoryKey] ?? `cat_${categoryKey}`;
      // Category 5 ("adversarial") often has answer = "" / null when the
      // correct behaviour is to refuse. Treat that as an abstention case.
      const goldAnswer =
        q.answer ?? (q as any).adversarial_answer ?? "";
      const abstention =
        category === "adversarial" &&
        (goldAnswer === null || goldAnswer === "" ||
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

// ── Question timing ─────────────────────────────────────────────────────────

/**
 * Per-turn timestamp spacing inside a session, mirroring `ingest.ts`
 * (`sessionDate + turnIdx * 60_000`). Used to place the end-of-conversation
 * fallback strictly after the last replayed turn.
 */
const TURN_OFFSET_MS = 60_000;

/**
 * Resolve the instant a question is "asked" on the replay timeline. The
 * production-faithful timeline scores each question against the memory state
 * valid at THIS moment (bi-temporal as-of retrieval), and releases it once the
 * global extraction frontier passes it.
 *
 *  - LongMemEval ships `questionDate` (the real reference "now") — use it.
 *  - Corpora without question timestamps (LoCoMo, some toy cases) fall back to
 *    "end of conversation": just after the final turn of the latest session, so
 *    the question can see every memory that conversation produced.
 *
 * Always returns a Date (sessions always carry timestamps), so the timeline and
 * the answerer's notion of "now" agree on a single instant per question.
 */
export function resolveQuestionDate(benchCase: BenchCase): Date {
  if (benchCase.questionDate) {
    const d = new Date(benchCase.questionDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return endOfConversationInstant(benchCase);
}

/**
 * The instant just after the last replayed turn across all of a case's
 * sessions. Used as the question-date fallback when a case carries no explicit
 * `questionDate`, so retrieval and the answerer's notion of "now" agree on a
 * single as-of instant.
 */
export function endOfConversationInstant(benchCase: BenchCase): Date {
  let latest = 0;
  for (const s of benchCase.sessions) {
    const base = new Date(s.timestamp).getTime();
    if (Number.isNaN(base)) continue;
    const end = base + Math.max(0, s.turns.length) * TURN_OFFSET_MS;
    if (end > latest) latest = end;
  }
  // +1s so a strict `T < frontier` release fires only after the last turn's
  // extraction (whose unit timestamp is the turn time) has completed.
  return latest > 0 ? new Date(latest + 1000) : new Date();
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

/**
 * Load BenchCase[] from an arbitrary normalized JSON file outside the corpus
 * directory. Useful for ad-hoc experiments where you don't want to fetch or
 * commit anything. The file must already be in normalized BenchCase shape.
 */
export async function loadExternalCorpus(filePath: string): Promise<BenchCase[]> {
  const abs = resolve(filePath);
  const raw = await readFile(abs, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `--corpus-file expects an array of BenchCase, got ${typeof parsed} at ${abs}`,
    );
  }
  return parsed as BenchCase[];
}

/**
 * Deterministic stratified sampler.
 *
 * Caps each category at `targetPerCategory`, applies a stable shuffle via the
 * seeded RNG, then prefers lower extraction-work cases inside each category.
 * The runtime budget matters because extraction cost tracks sessions/turns,
 * not just scored question count. Categories below the cap pass through
 * untouched. Output ordering is stable per (cases, target, seed) so a re-run
 * with the same inputs always picks the same questions.
 */
export function stratifiedSample(
  cases: BenchCase[],
  targetPerCategory: number,
  seed = 4711,
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
    shuffled.sort((a, b) => extractionWorkUnits(a) - extractionWorkUnits(b));
    out.push(...shuffled.slice(0, targetPerCategory));
  }
  return out;
}

function extractionWorkUnits(benchCase: BenchCase): number {
  const sessions = benchCase.sessions.length;
  const turns = benchCase.sessions.reduce((sum, s) => sum + s.turns.length, 0);
  // Sessions dominate because the default replay mode makes one LLM extraction
  // call per session. Turns are a light tie-breaker for long transcripts.
  return sessions * 1000 + turns;
}

/**
 * Subset size table. Keep these in one place so the CLI, the GitHub
 * Action, and any future runners agree on what each label means.
 *
 * Numbers reflect a per-category cap after stratified, extraction-work-aware
 * sampling, so the actual question count depends on how many categories the
 * dataset has. LongMemEval (cleaned) ships 6 categories; LoCoMo ships 5.
 *
 *   toy     2/category  → tiny deterministic plumbing pass.
 *   fast    1/category  → ~11 Qs total. A few minutes. Local sanity check.
 *   medium  30/category → ~329 Qs total. ~1 hour, ~$10. The server PR budget:
 *                         large enough for per-category deltas to mean something.
 *   full    no cap      → all loaded corpus questions (~2,486). Manual deep-dive.
 *
 * Runtime is dominated by extraction work over unique conversations/sessions,
 * not by final QA count alone. `medium` is the statistically-meaningful tier
 * the CI PR comment diffs against; `fast` is the cheap local smoke. Use
 * --limit/--cases for ad-hoc experiments.
 */
export const SUBSET_PER_CATEGORY = {
  toy: 2,
  fast: 1,
  medium: 30,
  full: Number.POSITIVE_INFINITY,
} as const;

/**
 * Deterministic total cap across the whole case list (all datasets/categories
 * combined). Stable seeded shuffle, then take the first `total`. Unlike
 * `stratifiedSample` (per-category), this caps the grand total — used by
 * `--cases=N` for quick smoke runs. Output is stable per (cases, total, seed).
 */
export function sampleTotal(
  cases: BenchCase[],
  total: number,
  seed = 4711,
): BenchCase[] {
  if (!Number.isFinite(total) || total <= 0 || cases.length <= total) {
    return cases;
  }
  const rng = mulberry32(seed);
  const shuffled = [...cases];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, total);
}

/** Legacy export kept for backward compatibility with existing tests. */
export const sampleFast = stratifiedSample;

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
