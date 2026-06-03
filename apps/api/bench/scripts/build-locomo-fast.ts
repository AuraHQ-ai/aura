/**
 * Build a small, failure-covering LoCoMo subset for FAST local iteration.
 *
 * Why this exists
 * ───────────────
 * A full LoCoMo run is ~105 min / ~$70, almost all of it spent re-ingesting and
 * re-extracting the 10 conversations (~3,075 per-reply extraction units). But
 * EVERY failure mode the full run surfaces (over-abstention, multi-hop partial
 * coverage, temporal day-precision, retrieval whiffs) lives DOWNSTREAM of
 * extraction — so once the memories exist, you never need to re-extract to
 * iterate on retrieval/ranking/answerer/temporal-format changes.
 *
 * The fast loop is therefore two existing primitives, no new machinery:
 *
 *   1. Seed ONCE   — extract all 10 conversations into a persistent workspace:
 *        pnpm bench:memory --dataset=locomo --subset=full \
 *          --bench-id=locomo --reset --to=extract --concurrency=10
 *      (~60 min, one time; `--to=extract` skips scoring so it's cheaper.)
 *
 *   2. Iterate     — score a curated subset against those memories, NO extract:
 *        pnpm bench:locomo-fast --emit            # writes the corpus file
 *        pnpm bench:memory --corpus-file=<file> --from=score --bench-id=locomo
 *      (~5–10 min, ~$8; `--from=score` reuses messages + memories.)
 *
 * Faithfulness: LoCoMo questions resolve to END-OF-CONVERSATION
 * (`resolveQuestionDate` → `endOfConversationInstant`), so the as-of retrieval
 * instant already includes every memory the conversation produced. With all
 * extraction complete (`--from=score`), each question retrieves bit-identically
 * to a full run — the extraction frontier only changes WHEN a question is
 * released, never WHAT it sees (see `bench/src/timeline.ts` `isReleasable` /
 * `scoreOne`). So the subset's numbers are directly comparable to the full run.
 *
 * This script is pure harness scaffolding (corpus SELECTION + expansion) — it
 * contains no memory logic, mirroring `fixtures.stratifiedSample`.
 *
 * Modes
 * ─────
 *   --select [--from-run=<id|path>] [--per-category=N] [--seed=N]
 *       (Re)derive the subset from a full LoCoMo run's cases.jsonl and write the
 *       committed manifest `bench/fast/locomo-fast.json` (case ids + the bucket
 *       each one exemplifies + provenance). Prints a projection table showing
 *       the subset's per-category QA (from the source run's verdicts) vs the
 *       full run — proof the subset tracks, at zero LLM cost.
 *
 *   --emit [--out=<path>]   (default mode)
 *       Read the committed manifest, load LoCoMo, filter to the selected ids,
 *       and write an expanded BenchCase[] corpus file (default
 *       /tmp/locomo-fast-corpus.json) ready for `--corpus-file`. Prints the
 *       exact run command.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUNS_ROOT = resolve(__dirname, "../runs");
const FAST_DIR = resolve(__dirname, "../fast");
const MANIFEST = resolve(FAST_DIR, "locomo-fast.json");

const argv = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

/** The failure taxonomy from the full-run post-mortem. A question is bucketed
 * from its recorded verdict + retrieval coverage; the subset guarantees each
 * mode is represented so a fix (or regression) on any of them shows up. */
type Bucket =
  | "pass" // correct / abstain_ok — control set: catches regressions
  | "partial_credit" // judge "partial" (0.5)
  | "over_abstain" // wrong, evidence fully retrieved, model said "I don't know"
  | "answerer_wrong" // wrong, evidence fully retrieved, model committed a wrong answer
  | "partial_coverage" // wrong, only some evidence sessions retrieved (multi-hop ranking)
  | "zero_coverage" // wrong, no evidence session retrieved (retrieval whiff)
  | "skipped"; // harness error

const ABSTAIN_RE =
  /(i don.?t know|not (mentioned|specified|available|provided|stated|clear|discussed)|no (information|mention|record|data)|cannot (determine|find|tell|answer)|unable to|isn.?t (mentioned|specified|clear)|don.?t have (enough|any|that))/i;

interface SourceCase {
  caseId: string;
  category: string;
  judgeVerdict: string;
  retrievalCoverage: number | null;
  modelAnswer: string;
}

function bucketOf(c: SourceCase): Bucket {
  const v = c.judgeVerdict;
  if (v === "correct" || v === "abstain_ok") return "pass";
  if (v === "partial") return "partial_credit";
  if (v === "skipped") return "skipped";
  const cov = c.retrievalCoverage ?? 0;
  if (cov <= 0.0001) return "zero_coverage";
  if (cov < 0.999) return "partial_coverage";
  if (ABSTAIN_RE.test(c.modelAnswer || "")) return "over_abstain";
  return "answerer_wrong";
}

function qaScore(verdict: string): number {
  if (verdict === "correct" || verdict === "abstain_ok") return 1;
  if (verdict === "partial") return 0.5;
  return 0;
}

/** Deterministic RNG (same family as fixtures.mulberry32) so re-selecting with
 * the same seed picks the same questions. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const CATEGORIES = ["adversarial", "single_hop", "multi_hop", "temporal", "open_domain"];
const BUCKETS: Bucket[] = [
  "pass",
  "partial_credit",
  "over_abstain",
  "answerer_wrong",
  "partial_coverage",
  "zero_coverage",
  "skipped",
];

interface ManifestEntry {
  id: string;
  category: string;
  bucket: Bucket;
}
interface Manifest {
  description: string;
  sourceRun: string;
  seed: number;
  perCategory: number;
  generatedAt: string;
  /** Projected per-category QA from the source run, subset vs full. */
  projection: Record<string, { subsetQa: number; fullQa: number; n: number; fullN: number }>;
  selection: ManifestEntry[];
}

function resolveRunCasesPath(fromRun: string | undefined): string {
  if (fromRun) {
    if (fromRun.endsWith(".jsonl")) return resolve(fromRun);
    return resolve(RUNS_ROOT, fromRun, "cases.jsonl");
  }
  // Newest run dir that has a cases.jsonl and contains a locomo case.
  const dirs = fs
    .readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "latest")
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    const p = resolve(RUNS_ROOT, d, "cases.jsonl");
    if (!fs.existsSync(p)) continue;
    const first = fs.readFileSync(p, "utf8").split("\n").find(Boolean);
    if (first && first.includes('"dataset":"locomo"')) return p;
  }
  throw new Error(
    `No LoCoMo run found under ${RUNS_ROOT}. Run a full LoCoMo bench first, or pass --from-run=<id|path>.`,
  );
}

function doSelect(): void {
  const perCategory = Number(getFlag("per-category") ?? 50);
  const seed = Number(getFlag("seed") ?? 4711);
  const casesPath = resolveRunCasesPath(getFlag("from-run"));
  const runId = casesPath.split("/").slice(-2, -1)[0] ?? "unknown";

  const source: SourceCase[] = fs
    .readFileSync(casesPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c: any) => c.dataset === "locomo")
    .map((c: any) => ({
      caseId: c.caseId,
      category: c.category,
      judgeVerdict: c.judgeVerdict,
      retrievalCoverage: c.retrievalCoverage ?? null,
      modelAnswer: c.modelAnswer ?? "",
    }));

  const byCat = new Map<string, SourceCase[]>();
  for (const c of source) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category)!.push(c);
  }

  const selection: ManifestEntry[] = [];
  const projection: Manifest["projection"] = {};
  for (const cat of CATEGORIES) {
    const list = byCat.get(cat) ?? [];
    if (list.length === 0) continue;
    const target = Math.min(perCategory, list.length);

    // Stratify by bucket: allocate each bucket a share of `target` proportional
    // to its share of the category, with a floor of 1 for every PRESENT bucket
    // so no failure mode is dropped. QA is a deterministic function of bucket
    // (pass/abstain_ok=1, partial=0.5, every fail bucket=0), so a proportional
    // sample reproduces the full per-category QA up to rounding — while the
    // floor still guarantees coverage of the rare buckets we most want to fix.
    const groups = new Map<Bucket, SourceCase[]>();
    for (const c of list) {
      const b = bucketOf(c);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b)!.push(c);
    }
    const alloc = new Map<Bucket, number>();
    for (const [b, g] of groups) {
      alloc.set(b, Math.max(1, Math.round((g.length / list.length) * target)));
    }
    // Reconcile the allocation back to exactly `target`: trim from the largest
    // buckets (never below their floor of 1), or grow them if we're short.
    const sumAlloc = () => [...alloc.values()].reduce((s, n) => s + n, 0);
    while (sumAlloc() > target) {
      const b = [...alloc.entries()]
        .filter(([, n]) => n > 1)
        .sort((a, b2) => b2[1] - a[1])[0];
      if (!b) break;
      alloc.set(b[0], b[1] - 1);
    }
    while (sumAlloc() < target) {
      const b = [...alloc.entries()]
        .filter(([bk, n]) => n < (groups.get(bk)?.length ?? 0))
        .sort((a, b2) => b2[1] - a[1])[0];
      if (!b) break;
      alloc.set(b[0], b[1] + 1);
    }

    const picked: SourceCase[] = [];
    for (const [b, g] of groups) {
      picked.push(...shuffle(g, seed + cat.length + b.length).slice(0, alloc.get(b) ?? 0));
    }
    for (const c of picked) selection.push({ id: c.caseId, category: cat, bucket: bucketOf(c) });
    const subsetQa = picked.reduce((s, c) => s + qaScore(c.judgeVerdict), 0) / picked.length;
    const fullQa = list.reduce((s, c) => s + qaScore(c.judgeVerdict), 0) / list.length;
    projection[cat] = { subsetQa, fullQa, n: picked.length, fullN: list.length };
  }

  const manifest: Manifest = {
    description:
      "Curated LoCoMo fast-iteration subset. Stratified seeded sample per category " +
      "that preserves the full run's QA mix and covers every failure bucket. Use with " +
      "`pnpm bench:locomo-fast --emit` + `--corpus-file ... --from=score` against a " +
      "workspace seeded once with the full LoCoMo extraction. See build-locomo-fast.ts.",
    sourceRun: runId,
    seed,
    perCategory,
    generatedAt: new Date().toISOString(),
    projection,
    selection,
  };
  fs.mkdirSync(FAST_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  // ── Report: tracking + coverage ──────────────────────────────────────────
  console.log(`Selected ${selection.length} case(s) from run ${runId} (seed=${seed}, perCategory=${perCategory}).`);
  console.log(`Wrote manifest: ${MANIFEST}\n`);
  console.log("Per-category QA — subset vs full (projection from source-run verdicts):");
  console.log("  category      subset   full    Δpp     n");
  let sQaSum = 0,
    sN = 0,
    fQaSum = 0,
    fN = 0;
  for (const cat of CATEGORIES) {
    const p = projection[cat];
    if (!p) continue;
    const d = (p.subsetQa - p.fullQa) * 100;
    console.log(
      `  ${cat.padEnd(13)} ${(p.subsetQa * 100).toFixed(1).padStart(5)}%  ${(p.fullQa * 100).toFixed(1).padStart(5)}%  ${(d >= 0 ? "+" : "") + d.toFixed(1).padStart(4)}   ${String(p.n).padStart(3)}/${p.fullN}`,
    );
    sQaSum += p.subsetQa * p.n;
    sN += p.n;
    fQaSum += p.fullQa * p.fullN;
    fN += p.fullN;
  }
  console.log(
    `  ${"OVERALL".padEnd(13)} ${((sQaSum / sN) * 100).toFixed(1).padStart(5)}%  ${((fQaSum / fN) * 100).toFixed(1).padStart(5)}%  ${(((sQaSum / sN) - (fQaSum / fN)) * 100 >= 0 ? "+" : "") + (((sQaSum / sN) - (fQaSum / fN)) * 100).toFixed(1).padStart(4)}   ${sN}/${fN}`,
  );

  console.log("\nFailure-bucket coverage in the subset (must hit every mode):");
  const bucketTotals = new Map<Bucket, number>();
  for (const e of selection) bucketTotals.set(e.bucket, (bucketTotals.get(e.bucket) ?? 0) + 1);
  for (const b of BUCKETS) console.log(`  ${b.padEnd(17)} ${bucketTotals.get(b) ?? 0}`);
}

async function doEmit(): Promise<void> {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(`No manifest at ${MANIFEST}. Run \`pnpm bench:locomo-fast --select\` first.`);
  }
  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const wantIds = new Set(manifest.selection.map((e) => e.id));

  const { loadLoCoMo } = await import("../src/fixtures.js");
  const all = await loadLoCoMo();
  if (all.length === 0) {
    throw new Error("LoCoMo corpus not found — run `pnpm bench:fetch-corpus` first.");
  }
  const byId = new Map(all.map((c) => [c.id, c]));
  const missing: string[] = [];
  const out = [];
  for (const e of manifest.selection) {
    const c = byId.get(e.id);
    if (c) out.push(c);
    else missing.push(e.id);
  }
  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} manifest id(s) not found in the current corpus (skipped).`);
  }

  const outPath = resolve(getFlag("out") ?? "/tmp/locomo-fast-corpus.json");
  fs.mkdirSync(resolve(outPath, ".."), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 0));
  console.log(`Wrote ${out.length} case(s) (of ${wantIds.size} selected) → ${outPath}`);
  console.log("\nSeed the workspace ONCE (skip if `bench-local-locomo` already extracted):");
  console.log(
    "  pnpm bench:memory --dataset=locomo --subset=full --bench-id=locomo --reset --to=extract --concurrency=10",
  );
  console.log("\nThen iterate (NO re-extraction — reuses the seeded memories):");
  console.log(`  pnpm bench:memory --corpus-file=${outPath} --from=score --bench-id=locomo`);
}

if (hasFlag("select")) {
  doSelect();
} else {
  await doEmit();
}
