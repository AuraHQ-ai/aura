/**
 * Fetch + slice the LongMemEval oracle corpus into a vendored subset.
 *
 * Usage:
 *   pnpm tsx apps/api/bench/scripts/fetch-longmemeval.ts \
 *     --out apps/api/bench/corpus/longmemeval-subset.json \
 *     --seed 4711
 *
 * LongMemEval is MIT-licensed
 * (https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE), so vendoring
 * a stratified subset into this repo with attribution is permitted. The
 * subset is deterministic for a given seed.
 *
 * Strategy:
 *   - Download `longmemeval_oracle.json` (oracle = evidence sessions only,
 *     cheapest replay).
 *   - Stratify by `question_type`, keep only the axes most relevant to
 *     epic #1042: temporal-reasoning, knowledge-update, abstention.
 *   - Sample at most TARGET_PER_AXIS questions from each.
 *   - Write the trimmed JSON next to manifest.json.
 *
 * If the upstream file is removed or renamed, the script logs a clear
 * error so a future maintainer can patch the URL without spelunking.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ORACLE_URL =
  process.env.LONGMEMEVAL_URL ??
  "https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/data/longmemeval_oracle.json";

const TARGET_AXES = new Set([
  "temporal-reasoning",
  "knowledge-update",
  "abstention",
]);
const TARGET_PER_AXIS = 34; // 3 × 34 ≈ 100, the budget in #1043.

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const out = getArg("--out");
const seed = Number(getArg("--seed") ?? "4711");
if (!out) {
  console.error("Missing --out=<path>");
  process.exit(1);
}

function mulberry32(s: number): () => number {
  let state = s >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  console.log(`Fetching ${ORACLE_URL}…`);
  const res = await fetch(ORACLE_URL);
  if (!res.ok) {
    throw new Error(
      `LongMemEval download failed (${res.status} ${res.statusText}). If the upstream file moved, set LONGMEMEVAL_URL.`,
    );
  }
  const raw = (await res.json()) as Array<{
    question_id: string;
    question_type: string;
    question: string;
    answer: string;
    haystack_session_ids: string[];
    haystack_dates: string[];
    haystack_sessions: Array<Array<{ role: string; content: string }>>;
    answer_session_ids?: string[];
  }>;

  const buckets = new Map<string, typeof raw>();
  for (const r of raw) {
    if (!TARGET_AXES.has(r.question_type)) continue;
    if (!buckets.has(r.question_type)) buckets.set(r.question_type, []);
    buckets.get(r.question_type)!.push(r);
  }

  const rng = mulberry32(seed);
  const picked: typeof raw = [];
  for (const axis of TARGET_AXES) {
    const bucket = buckets.get(axis) ?? [];
    const shuffled = [...bucket];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    picked.push(...shuffled.slice(0, TARGET_PER_AXIS));
    console.log(`  ${axis}: ${Math.min(TARGET_PER_AXIS, bucket.length)} / ${bucket.length}`);
  }

  mkdirSync(dirname(out!), { recursive: true });
  writeFileSync(out!, JSON.stringify(picked, null, 2));
  console.log(`Wrote ${picked.length} questions to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
