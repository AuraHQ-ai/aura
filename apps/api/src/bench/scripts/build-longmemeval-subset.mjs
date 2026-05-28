#!/usr/bin/env node
/**
 * Rebuild longmemeval-subset.json from longmemeval_oracle.json (MIT).
 * Usage: node apps/api/src/bench/scripts/build-longmemeval-subset.mjs [/path/to/oracle.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 1043;
const TARGETS = {
  "temporal-reasoning": 40,
  "knowledge-update": 25,
  "multi-session": 35,
};

const oraclePath = process.argv[2] ?? "/tmp/longmemeval_oracle.json";
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

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "../corpus");
mkdirSync(corpusDir, { recursive: true });
const json = JSON.stringify(norm, null, 2);
const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
writeFileSync(join(corpusDir, "longmemeval-subset.json"), json);
writeFileSync(
  join(corpusDir, "manifest.json"),
  JSON.stringify(
    {
      corpus_hash: hash,
      seed: SEED,
      total: norm.length,
      source: "longmemeval_oracle.json",
      license: "MIT",
      counts: Object.fromEntries(
        [...new Set(norm.map((c) => c.category))].map((c) => [
          c,
          norm.filter((x) => x.category === c).length,
        ]),
      ),
    },
    null,
    2,
  ),
);
console.log(`Wrote ${norm.length} cases, corpus_hash=${hash}`);
