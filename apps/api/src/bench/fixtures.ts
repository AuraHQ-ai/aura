import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CORPUS_DIR } from "./corpus/ensure-corpus.js";
import type { BenchCase, BenchDataset, BenchSubset } from "./types.js";

export const SUBSET_PER_CATEGORY: Record<BenchSubset, number> = {
  fast: 5,
  medium: 15,
  full: Infinity,
};

export function stratifiedSample(
  cases: BenchCase[],
  perCategory: number,
  seed: number,
): BenchCase[] {
  const byCat = new Map<string, BenchCase[]>();
  for (const c of cases) {
    const list = byCat.get(c.category) ?? [];
    list.push(c);
    byCat.set(c.category, list);
  }

  const out: BenchCase[] = [];
  for (const [, pool] of byCat) {
    const cap = Number.isFinite(perCategory) ? perCategory : pool.length;
    const catSeed = pool[0] ? pool[0].category.length : 0;
    const picked = seededPick(pool, cap, seed + catSeed);
    out.push(...picked);
  }
  return out;
}

function seededPick(arr: BenchCase[], n: number, seed: number): BenchCase[] {
  const out: BenchCase[] = [];
  const used = new Set<number>();
  let s = seed;
  while (out.length < n && out.length < arr.length) {
    s = (s * 1103515245 + 12345) >>> 0;
    const i = s % arr.length;
    if (!used.has(i)) {
      used.add(i);
      out.push(arr[i]);
    }
  }
  return out;
}

function loadJson(path: string): BenchCase[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as BenchCase[];
}

export function loadToyCases(): BenchCase[] {
  return loadJson(join(CORPUS_DIR, "toy-corpus.json"));
}

export function loadLongMemEvalCases(): BenchCase[] {
  const subset = join(CORPUS_DIR, "cache", "longmemeval-subset.json");
  if (existsSync(subset)) return loadJson(subset);
  return loadJson(join(CORPUS_DIR, "cache", "longmemeval_oracle.json"));
}

export function loadLoCoMoCases(): BenchCase[] {
  return loadJson(join(CORPUS_DIR, "cache", "locomo10.json"));
}

export function loadCases(options: {
  dataset: BenchDataset;
  subset: BenchSubset;
  category?: string;
}): BenchCase[] {
  const { dataset, subset, category } = options;
  let cases: BenchCase[] = [];

  if (dataset === "toy") cases = loadToyCases();
  else if (dataset === "lme") cases = loadLongMemEvalCases();
  else if (dataset === "locomo") cases = loadLoCoMoCases();
  else if (dataset === "both") cases = [...loadLongMemEvalCases(), ...loadLoCoMoCases()];

  const perCat = SUBSET_PER_CATEGORY[subset];
  if (subset !== "full" && cases.length > 0) {
    cases = stratifiedSample(cases, perCat, 1043);
  }

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

export function loadManifest(): { corpus_hash: string | null; total: number } {
  const manifestPath = join(CORPUS_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return { corpus_hash: null, total: 0 };
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    subset_targets?: Record<string, number>;
  };
  const total = m.subset_targets
    ? Object.values(m.subset_targets).reduce((a, b) => a + b, 0)
    : 0;
  const subsetPath = join(CORPUS_DIR, "cache", "longmemeval-subset.json");
  if (!existsSync(subsetPath)) return { corpus_hash: null, total };
  const hash = createHash("sha256")
    .update(readFileSync(subsetPath))
    .digest("hex")
    .slice(0, 16);
  return { corpus_hash: hash, total };
}
