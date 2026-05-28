import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { BenchCase, BenchDataset, BenchManifest, BenchSubset } from "./types.js";

const corpusRoot = new URL("../corpus/", import.meta.url);

async function readJson<T>(fileName: string): Promise<T> {
  const raw = await readFile(new URL(fileName, corpusRoot), "utf8");
  return JSON.parse(raw) as T;
}

export async function loadManifest(): Promise<BenchManifest> {
  return readJson<BenchManifest>("manifest.json");
}

export async function computeCorpusHash(corpusFile?: string): Promise<string> {
  if (corpusFile) {
    const raw = await readFile(resolve(corpusFile));
    return createHash("sha256").update(raw).digest("hex");
  }

  const manifest = await loadManifest();
  const hash = createHash("sha256");
  for (const dataset of manifest.datasets.filter((d) => d.included)) {
    hash.update(dataset.file);
    hash.update(await readFile(new URL(dataset.file, corpusRoot)));
  }
  return hash.digest("hex");
}

export async function loadBenchCases(params: {
  dataset: BenchDataset;
  subset: BenchSubset;
  category?: string;
  corpusFile?: string;
}): Promise<BenchCase[]> {
  const cases = params.corpusFile
    ? await readJsonFromPath<BenchCase[]>(params.corpusFile)
    : await loadManifestCases(params.dataset);
  const datasetFiltered = params.corpusFile && params.dataset !== "both"
    ? cases.filter((benchCase) =>
      params.dataset === "lme"
        ? benchCase.source === "longmemeval"
        : benchCase.source === "locomo"
    )
    : cases;
  const filtered = params.category
    ? datasetFiltered.filter((benchCase) => benchCase.category === params.category)
    : datasetFiltered;

  if (params.subset === "fast") {
    return filtered.slice(0, 40);
  }

  return filtered;
}

async function readJsonFromPath<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf8");
  return JSON.parse(raw) as T;
}

async function loadManifestCases(dataset: BenchDataset): Promise<BenchCase[]> {
  const manifest = await loadManifest();
  const files = manifest.datasets
    .filter((entry) => entry.included)
    .filter((entry) => {
      if (dataset === "both") return true;
      if (dataset === "lme") return entry.name === "longmemeval";
      return entry.name === "locomo";
    });

  return (await Promise.all(files.map((file) => readJson<BenchCase[]>(file.file)))).flat();
}
