import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchCase, BenchDataset, BenchSubset } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "corpus");

const FAST_PER_CATEGORY = 3;
const FAST_CATEGORIES = ["temporal_reasoning", "knowledge_update", "multi_session"];

export function loadManifest(): { corpus_hash: string; total: number } {
  const raw = readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8");
  return JSON.parse(raw) as { corpus_hash: string; total: number };
}

function loadJsonCases(filename: string): BenchCase[] {
  const path = join(CORPUS_DIR, filename);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as BenchCase[];
}

export function loadToyCases(): BenchCase[] {
  return loadJsonCases("toy-corpus.json");
}

export function loadLongMemEvalCases(): BenchCase[] {
  return loadJsonCases("longmemeval-subset.json");
}

export function loadLoCoMoCases(): BenchCase[] {
  return loadJsonCases("locomo-subset.json");
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
  return cases.slice(0, 9);
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
