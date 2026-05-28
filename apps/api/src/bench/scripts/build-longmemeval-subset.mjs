#!/usr/bin/env node
/**
 * Build longmemeval-subset.json into corpus/cache/ (gitignored).
 * Usage: node apps/api/src/bench/scripts/build-longmemeval-subset.mjs [/path/to/oracle.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(__dirname, "../corpus");
const cacheDir = join(corpusDir, "cache");

const manifest = JSON.parse(
  readFileSync(join(corpusDir, "manifest.json"), "utf8"),
);
const SEED = manifest.subset_seed ?? 1043;
const TARGETS = manifest.subset_targets ?? {
  "temporal-reasoning": 40,
  "knowledge-update": 25,
  "multi-session": 35,
};

const oraclePath = process.argv[2] ?? join(cacheDir, "longmemeval_oracle.json");
const data = JSON.parse(readFileSync(oraclePath, "utf8"));

function seededPick(arr, n, seed) {
  const out = [];
  const used = new Set();
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

const subset = [];
for (const [cat, n] of Object.entries(TARGETS)) {
  const pool = data.filter((q) => q.question_type === cat);
  subset.push(...seededPick(pool, n, SEED + cat.length));
}

const norm = subset.map((q) => ({
  id: q.question_id,
  source: "longmemeval",
  category: q.question_type.replace(/-/g, "_"),
  question: q.question,
  goldAnswer: q.answer,
  abstention: false,
  sessions: q.haystack_session_ids.map((sid, idx) => ({
    id: sid,
    timestamp: q.haystack_dates[idx] ?? q.question_date,
    turns: q.haystack_sessions[idx].map((t) => ({
      role: t.role === "user" ? "user" : "assistant",
      content: t.content,
    })),
  })),
  evidenceSessionIds: q.haystack_session_ids,
}));

mkdirSync(cacheDir, { recursive: true });
const json = JSON.stringify(norm, null, 2);
const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
writeFileSync(join(cacheDir, "longmemeval-subset.json"), json);
console.log(`Wrote ${norm.length} cases to cache/longmemeval-subset.json (hash ${hash})`);
