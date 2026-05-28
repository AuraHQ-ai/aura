import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BenchCase, BenchDataset, BenchManifest, BenchSubset } from "./types.js";

const corpusRoot = new URL("../corpus/", import.meta.url);

async function readJson<T>(fileName: string): Promise<T> {
  const raw = await readFile(new URL(fileName, corpusRoot), "utf8");
  return JSON.parse(raw) as T;
}

export async function loadManifest(): Promise<BenchManifest> {
  return readJson<BenchManifest>("manifest.json");
}

export async function computeCorpusHash(): Promise<string> {
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
}): Promise<BenchCase[]> {
  const manifest = await loadManifest();
  const files = manifest.datasets
    .filter((dataset) => dataset.included)
    .filter((dataset) => {
      if (params.dataset === "both") return true;
      if (params.dataset === "lme") return dataset.name === "longmemeval";
      return dataset.name === "locomo";
    });

  const cases = (await Promise.all(files.map((file) => readJson<BenchCase[]>(file.file)))).flat();
  const filtered = params.category
    ? cases.filter((benchCase) => benchCase.category === params.category)
    : cases;

  if (params.subset === "fast") {
    return filtered.slice(0, 40);
  }

  return filtered;
}
