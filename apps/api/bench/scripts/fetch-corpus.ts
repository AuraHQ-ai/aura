/**
 * Fetch (and cache) the LoCoMo + LongMemEval corpora into
 * apps/api/bench/corpus/cache/.
 *
 * Idempotent: re-running with the cache already populated is a no-op
 * (the script prints a hash and exits). Pass `--force` to redownload.
 *
 * Usage:
 *   pnpm --filter aura-api bench:fetch-corpus
 *   pnpm --filter aura-api bench:fetch-corpus -- --force
 *
 * The fetched files are gitignored. They sit alongside the always-
 * vendored toy fixture and the committed manifest.json. The runner
 * resolves which corpus file to load via the manifest.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(__dirname, "../corpus");
const CACHE_DIR = resolve(CORPUS_DIR, "cache");

const argv = process.argv.slice(2);
const force = argv.includes("--force");

interface ManifestEntry {
  file: string;
  vendored?: boolean;
  fetchUrl?: string;
  fallbackUrl?: string;
}

interface Manifest {
  version: number;
  datasets: Record<string, ManifestEntry>;
}

async function tryFetch(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "aura-bench-fetch-corpus" },
    });
    if (!res.ok) {
      console.error(`  ${url} -> HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (error) {
    console.error(`  ${url} -> ${String(error).slice(0, 200)}`);
    return null;
  }
}

async function fetchOne(name: string, entry: ManifestEntry): Promise<void> {
  if (entry.vendored !== false) {
    console.log(`[skip] ${name}: vendored in tree`);
    return;
  }
  if (!entry.fetchUrl) {
    console.error(`[err]  ${name}: no fetchUrl in manifest`);
    return;
  }

  const target = resolve(CORPUS_DIR, entry.file);
  mkdirSync(dirname(target), { recursive: true });

  if (existsSync(target) && !force) {
    const size = statSync(target).size;
    const data = await readFile(target);
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
    console.log(`[ok]   ${name}: cached (${(size / 1024 / 1024).toFixed(1)} MB, sha=${hash})`);
    return;
  }

  console.log(`[fetch] ${name}: ${entry.fetchUrl}`);
  let buf = await tryFetch(entry.fetchUrl);
  if (!buf && entry.fallbackUrl) {
    console.log(`[fetch] ${name}: trying fallback ${entry.fallbackUrl}`);
    buf = await tryFetch(entry.fallbackUrl);
  }
  if (!buf) {
    throw new Error(`Failed to download ${name} from any of its sources.`);
  }

  // Sanity-check that we got JSON. Some hosts return HTML on 404 with 200 OK.
  const head = buf.subarray(0, 64).toString("utf8").trim();
  if (!head.startsWith("[") && !head.startsWith("{")) {
    throw new Error(
      `${name}: response does not look like JSON (starts with "${head.slice(0, 40)}…")`,
    );
  }

  await writeFile(target, buf);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  console.log(
    `[ok]   ${name}: wrote ${target} (${(buf.length / 1024 / 1024).toFixed(1)} MB, sha=${hash})`,
  );
}

async function main(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const manifest = JSON.parse(
    await readFile(resolve(CORPUS_DIR, "manifest.json"), "utf8"),
  ) as Manifest;

  for (const [name, entry] of Object.entries(manifest.datasets)) {
    await fetchOne(name, entry);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
