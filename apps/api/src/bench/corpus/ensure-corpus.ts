import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = __dirname;
export const CACHE_DIR = join(CORPUS_DIR, "cache");
const SUBSET_PATH = join(CACHE_DIR, "longmemeval-subset.json");
const ORACLE_CACHE = join(CACHE_DIR, "longmemeval_oracle.json");

const ORACLE_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json";

export type CorpusManifest = {
  subset_seed: number;
  subset_targets: Record<string, number>;
  oracle_url: string;
  license: string;
};

export function readManifest(): CorpusManifest & { subset_file: string } {
  const raw = readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8");
  const base = JSON.parse(raw) as CorpusManifest;
  return { ...base, subset_file: "cache/longmemeval-subset.json" };
}

function downloadOracle(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  execSync(`curl -fsSL "${ORACLE_URL}" -o "${ORACLE_CACHE}"`, {
    stdio: "inherit",
  });
}

/** Build or download the 100-Q LongMemEval subset into corpus/cache/ (gitignored). */
export function ensureLongMemEvalSubset(): string {
  if (existsSync(SUBSET_PATH)) {
    return SUBSET_PATH;
  }

  const buildScript = join(CORPUS_DIR, "../scripts/build-longmemeval-subset.mjs");
  if (!existsSync(ORACLE_CACHE)) {
    console.log("Downloading longmemeval_oracle.json…");
    downloadOracle();
  }

  console.log("Building longmemeval-subset.json…");
  execSync(`node "${buildScript}" "${ORACLE_CACHE}"`, { stdio: "inherit" });
  if (!existsSync(SUBSET_PATH)) {
    throw new Error(`Expected subset at ${SUBSET_PATH} after build`);
  }
  return SUBSET_PATH;
}

export function subsetCorpusHash(): string | null {
  if (!existsSync(SUBSET_PATH)) return null;
  const json = readFileSync(SUBSET_PATH, "utf8");
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
