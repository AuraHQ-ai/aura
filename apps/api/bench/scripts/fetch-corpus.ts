import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusDir = resolve(__dirname, "../corpus");
const cacheDir = resolve(corpusDir, "cache");
const force = process.argv.includes("--force");

interface ManifestEntry {
  file: string;
  vendored?: boolean;
  fetchUrl?: string;
}

interface Manifest {
  datasets: Record<string, ManifestEntry>;
}

async function tryFetch(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "aura-memory-bench" },
    });
    if (!response.ok) {
      console.error(`${url} -> HTTP ${response.status} ${response.statusText}`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error(`${url} -> ${String(error).slice(0, 200)}`);
    return null;
  }
}

async function fetchOne(name: string, entry: ManifestEntry): Promise<void> {
  if (entry.vendored !== false) {
    console.log(`[skip] ${name}: vendored`);
    return;
  }
  if (!entry.fetchUrl) {
    throw new Error(`${name}: missing fetchUrl`);
  }

  const target = resolve(corpusDir, entry.file);
  mkdirSync(dirname(target), { recursive: true });

  if (existsSync(target) && !force) {
    const raw = await readFile(target);
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
    const sizeMb = statSync(target).size / 1024 / 1024;
    console.log(`[ok] ${name}: cached (${sizeMb.toFixed(1)} MB, sha=${hash})`);
    return;
  }

  console.log(`[fetch] ${name}: ${entry.fetchUrl}`);
  const raw = await tryFetch(entry.fetchUrl);
  if (!raw) throw new Error(`${name}: download failed`);
  const head = raw.subarray(0, 64).toString("utf8").trim();
  if (!head.startsWith("[") && !head.startsWith("{")) {
    throw new Error(`${name}: response does not look like JSON`);
  }

  await writeFile(target, raw);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  console.log(`[ok] ${name}: wrote ${target} (sha=${hash})`);
}

const manifest = JSON.parse(
  await readFile(resolve(corpusDir, "manifest.json"), "utf8"),
) as Manifest;

mkdirSync(cacheDir, { recursive: true });
for (const [name, entry] of Object.entries(manifest.datasets)) {
  await fetchOne(name, entry);
}
