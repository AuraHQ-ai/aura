/**
 * Fetch benchmark corpora into corpus/cache/ (gitignored).
 * Run: pnpm --filter aura-api bench:fetch-corpus
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = __dirname;
export const CACHE_DIR = join(CORPUS_DIR, "cache");

const force = process.argv.includes("--force");

type ManifestEntry = {
  file: string;
  vendored?: boolean;
  fetchUrl?: string;
};

type Manifest = {
  datasets?: Record<string, ManifestEntry>;
  oracle_url?: string;
  subset_targets?: Record<string, number>;
};

async function tryFetch(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "aura-bench-fetch-corpus" },
    });
    if (!res.ok) {
      console.error(`  ${url} -> HTTP ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (error) {
    console.error(`  ${url} -> ${String(error).slice(0, 120)}`);
    return null;
  }
}

async function fetchOne(name: string, entry: ManifestEntry): Promise<void> {
  if (entry.vendored) {
    console.log(`[skip] ${name}: vendored`);
    return;
  }
  if (!entry.fetchUrl) return;

  const target = join(CORPUS_DIR, entry.file);
  mkdirSync(dirname(target), { recursive: true });

  if (existsSync(target) && !force) {
    const data = readFileSync(target);
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
    console.log(`[ok]   ${name}: cached (${(data.length / 1e6).toFixed(1)} MB, ${hash})`);
    return;
  }

  console.log(`[fetch] ${name}: ${entry.fetchUrl}`);
  const buf = await tryFetch(entry.fetchUrl);
  if (!buf) throw new Error(`Failed to download ${name}`);
  const head = buf.subarray(0, 32).toString("utf8").trim();
  if (!head.startsWith("[") && !head.startsWith("{")) {
    throw new Error(`${name}: response is not JSON`);
  }
  writeFileSync(target, buf);
  console.log(`[ok]   ${name}: wrote ${(buf.length / 1e6).toFixed(1)} MB`);
}

async function main(): Promise<void> {
  const manifest: Manifest = JSON.parse(
    readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8"),
  );

  mkdirSync(CACHE_DIR, { recursive: true });

  if (manifest.datasets) {
    for (const [name, entry] of Object.entries(manifest.datasets)) {
      await fetchOne(name, entry);
    }
  } else if (manifest.oracle_url) {
    const oraclePath = join(CACHE_DIR, "longmemeval_oracle.json");
    if (!existsSync(oraclePath) || force) {
      const buf = await tryFetch(manifest.oracle_url);
      if (!buf) throw new Error("oracle download failed");
      writeFileSync(oraclePath, buf);
    }
  }

  const subsetPath = join(CACHE_DIR, "longmemeval-subset.json");
  const oraclePath = join(CACHE_DIR, "longmemeval_oracle.json");
  if (existsSync(oraclePath) && (!existsSync(subsetPath) || force)) {
    const buildScript = join(CORPUS_DIR, "../scripts/build-longmemeval-subset.mjs");
    execSync(`node "${buildScript}" "${oraclePath}"`, { stdio: "inherit" });
  }

  if (existsSync(subsetPath)) {
    const hash = createHash("sha256")
      .update(readFileSync(subsetPath))
      .digest("hex")
      .slice(0, 16);
    console.log(`Subset ready: ${subsetPath} (${(statSync(subsetPath).size / 1e6).toFixed(2)} MB, ${hash})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
