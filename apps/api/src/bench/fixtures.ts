import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BenchCase, BenchDataset, BenchSubset } from "./types.js";
import {
  CORPUS_DIR,
  ensureLongMemEvalSubset,
  readManifest,
  subsetCorpusHash,
} from "./corpus/ensure-corpus.js";

const FAST_PER_CATEGORY = 5;
const FAST_CATEGORIES = ["temporal_reasoning", "knowledge_update", "multi_session"];

export function loadManifest(): { corpus_hash: string | null; total: number } {
  const manifest = readManifest();
  const hash = subsetCorpusHash();
  const total = Object.values(manifest.subset_targets).reduce((a, b) => a + b, 0);
  return { corpus_hash: hash, total };
}

function loadJsonCases(path: string): BenchCase[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as BenchCase[];
}

export function loadToyCases(): BenchCase[] {
  return loadJsonCases(join(CORPUS_DIR, "toy-corpus.json"));
}

export function loadLongMemEvalCases(): BenchCase[] {
  const path = ensureLongMemEvalSubset();
  return loadJsonCases(path);
}

export function loadLoCoMoCases(): BenchCase[] {
  const cached = join(CORPUS_DIR, "cache", "locomo-subset.json");
  return loadJsonCases(cached);
}

function applySubset(cases: BenchCase[], subset: BenchSubset): BenchCase[] {
  if (subset === "full") return cases;
  const byCat = new Map<string, BenchCase[]>();
  for (const c of cases) {
    const list = byCat.get(c.category) ?? [];
    list.push(c);
    byCat.set(c.category, list);
  }
  const out: BenchCase[] = [];
  for (const cat of FAST_CATEGORIES) {
    const list = byCat.get(cat) ?? [];
    out.push(...list.slice(0, FAST_PER_CATEGORY));
  }
  if (out.length > 0) return out;
  return cases.slice(0, 15);
}

export function loadCases(options: {
  dataset: BenchDataset;
  subset: BenchSubset;
  category?: string;
}): BenchCase[] {
  const { dataset, subset, category } = options;
  let cases: BenchCase[] = [];

  if (dataset === "toy") {
    cases = loadToyCases();
  } else if (dataset === "lme") {
    cases = loadLongMemEvalCases();
  } else if (dataset === "locomo") {
    cases = loadLoCoMoCases();
  } else if (dataset === "both") {
    cases = [...loadLongMemEvalCases(), ...loadLoCoMoCases()];
  }

  cases = applySubset(cases, subset);
  if (category) {
    cases = cases.filter(
      (c) => c.category === category || c.category.replace(/-/g, "_") === category,
    );
  }
  return cases;
}

export function corpusHashForCases(cases: BenchCase[]): string {
  const json = JSON.stringify(cases.map((c) => c.id).sort());
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
