import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BenchCase, BenchDataset, BenchSubset, DatasetId } from "./types.js";

const corpusRoot = new URL("../corpus/", import.meta.url);

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
  description?: string;
  datasets: Record<DatasetId, ManifestEntry>;
}

async function readCorpusJson<T>(fileName: string): Promise<T> {
  const raw = await readFile(new URL(fileName, corpusRoot), "utf8");
  return JSON.parse(raw) as T;
}

async function readJsonFromPath<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf8");
  return JSON.parse(raw) as T;
}

export async function loadManifest(): Promise<Manifest> {
  return readCorpusJson<Manifest>("manifest.json");
}

function normalizeDataset(dataset: BenchDataset): DatasetId[] {
  if (dataset === "both") return ["longmemeval", "locomo"];
  if (dataset === "lme") return ["longmemeval"];
  return [dataset];
}

async function corpusPath(datasetId: DatasetId): Promise<string | null> {
  const manifest = await loadManifest();
  const entry = manifest.datasets[datasetId];
  if (!entry) return null;
  const url = new URL(entry.file, corpusRoot);
  return existsSync(url) ? url.pathname : null;
}

export async function computeCorpusHash(params: {
  dataset: BenchDataset;
  corpusFile?: string;
}): Promise<string> {
  if (params.corpusFile) {
    const raw = await readFile(resolve(params.corpusFile));
    return createHash("sha256").update(raw).digest("hex");
  }

  const hash = createHash("sha256");
  hash.update(await readFile(new URL("manifest.json", corpusRoot)));
  for (const datasetId of normalizeDataset(params.dataset).sort()) {
    const path = await corpusPath(datasetId);
    if (!path) continue;
    hash.update(datasetId);
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

export async function loadBenchCases(params: {
  dataset: BenchDataset;
  subset: BenchSubset;
  category?: string;
  corpusFile?: string;
}): Promise<BenchCase[]> {
  const loadedCases = params.corpusFile
    ? await readJsonFromPath<BenchCase[]>(params.corpusFile)
    : (await Promise.all(normalizeDataset(params.dataset).map(loadDataset))).flat();
  const allowedDatasets = new Set(normalizeDataset(params.dataset));
  const cases = params.corpusFile
    ? loadedCases.filter((benchCase) => allowedDatasets.has(benchCase.source))
    : loadedCases;

  const filtered = params.category
    ? cases.filter((benchCase) => benchCase.category === params.category)
    : cases;

  const perCategory = SUBSET_PER_CATEGORY[params.subset];
  return Number.isFinite(perCategory)
    ? stratifiedSample(filtered, perCategory)
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
  cases: BenchCase[];
}

export async function loadToyCorpus(): Promise<BenchCase[]> {
  const path = await corpusPath("toy");
  if (!path) return [];
  const data = await readJsonFromPath<ToyCorpus>(path);
  return data.cases.map((benchCase) => ({
    ...benchCase,
    source: "toy",
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
    turns: Array<{ role: string; content: string; diaId?: string }>;
  }>;
}

async function loadLongMemEval(): Promise<BenchCase[]> {
  const path = await corpusPath("longmemeval");
  if (!path) return [];
  const records = await readJsonFromPath<LongMemEvalRecord[]>(path);

  return records.map((record, index): BenchCase => {
    const id = record.question_id ?? record.id ?? `lme-${index}`;
    const category = (record.category ?? record.question_type ?? "unknown").replace(/-/g, "_");
    const goldAnswer = record.goldAnswer ?? record.answer ?? "";
    const abstention = record.abstention ?? category === "abstention";
    const sessions = record.sessions ??
      (record.haystack_sessions ?? []).map((turns, sessionIndex) => ({
        id: record.haystack_session_ids?.[sessionIndex] ?? `s${sessionIndex + 1}`,
        timestamp: record.haystack_dates?.[sessionIndex] ?? "2024-01-01T00:00:00.000Z",
        turns,
      }));

    return {
      id,
      source: "longmemeval",
      category,
      question: record.question,
      goldAnswer,
      abstention,
      sessions: sessions.map((session) => ({
        id: session.id ?? "s",
        timestamp: session.timestamp ?? "2024-01-01T00:00:00.000Z",
        turns: session.turns.map((turn, turnIndex) => ({
          diaId: ("diaId" in turn ? turn.diaId : undefined) ?? `${session.id ?? "s"}:${turnIndex + 1}`,
          role: turn.role === "assistant" || turn.role === "bot" || turn.role === "ai"
            ? "assistant"
            : "user",
          content: turn.content,
        })),
      })),
      evidenceSessionIds: record.answer_session_ids,
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

function parseLocomoDate(raw: string | undefined, fallbackIndex: number): string {
  if (raw) {
    const parsed = new Date(raw.replace(/\s+on\s+/i, " ").trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(Date.UTC(2024, 0, 1 + fallbackIndex)).toISOString();
}

async function loadLoCoMo(): Promise<BenchCase[]> {
  const path = await corpusPath("locomo");
  if (!path) return [];
  const raw = await readJsonFromPath<LoCoMoConversation[] | LoCoMoConversation>(path);
  const conversations = Array.isArray(raw) ? raw : [raw];

  const cases: BenchCase[] = [];
  for (const conversationWrapper of conversations) {
    const conversation = conversationWrapper.conversation;
    if (!conversation) continue;

    const conversationId = conversationWrapper.sample_id ?? "locomo";
    const speakerA = conversation.speaker_a ?? "A";
    const sessionKeys = Object.keys(conversation)
      .filter((key) => /^session_\d+$/.test(key))
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));

    const sessions = sessionKeys.map((sessionKey, index) => {
      const sessionNumber = Number(sessionKey.slice("session_".length));
      const turns = (conversation[sessionKey] as LoCoMoTurn[] | undefined) ?? [];
      return {
        id: `D${sessionNumber}`,
        timestamp: parseLocomoDate(
          conversation[`${sessionKey}_date_time`] as string | undefined,
          index,
        ),
        turns: turns.map((turn, turnIndex) => ({
          diaId: turn.dia_id ?? `D${sessionNumber}:${turnIndex + 1}`,
          role: turn.speaker === speakerA ? "user" as const : "assistant" as const,
          speaker: turn.speaker,
          content: turn.text,
        })),
      };
    });

    for (const [questionIndex, question] of (conversationWrapper.qa ?? []).entries()) {
      const category = LOCOMO_CATEGORY_NAMES[String(question.category ?? "")]
        ?? `cat_${question.category ?? "unknown"}`;
      const goldAnswer = question.answer ?? question.adversarial_answer ?? "";
      const abstention = category === "adversarial" &&
        (goldAnswer === null || goldAnswer === "" ||
          (Array.isArray(goldAnswer) && goldAnswer.length === 0));
      const evidenceDiaIds = question.evidence ?? [];

      cases.push({
        id: `${conversationId}-q${questionIndex}`,
        source: "locomo",
        category,
        question: question.question,
        goldAnswer: goldAnswer ?? "",
        abstention,
        sessions,
        evidenceDiaIds,
        evidenceSessionIds: [...new Set(evidenceDiaIds.map((diaId) => diaId.split(":")[0]))],
      });
    }
  }

  return cases;
}

export const SUBSET_PER_CATEGORY = {
  fast: 4,
  medium: 30,
  full: Number.POSITIVE_INFINITY,
} as const;

export function stratifiedSample(
  cases: BenchCase[],
  targetPerCategory: number,
  seed = 4711,
): BenchCase[] {
  const byCategory = new Map<string, BenchCase[]>();
  for (const benchCase of cases) {
    const group = byCategory.get(benchCase.category) ?? [];
    group.push(benchCase);
    byCategory.set(benchCase.category, group);
  }

  const rng = mulberry32(seed);
  const out: BenchCase[] = [];
  for (const group of byCategory.values()) {
    const shuffled = [...group];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(rng() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
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
