/**
 * Investigate a memory bench run's failures — the persisted version of the
 * throwaway repro scripts we keep rewriting during failure post-mortems.
 *
 * Three modes, in increasing depth:
 *
 *   pnpm bench:inspect                       # newest run: per-category tally + failure list
 *   pnpm bench:inspect --run-id=<id>         # a specific run (dir under bench/runs/)
 *   pnpm bench:inspect --workspace=<ws>      # find the run whose workspace matches
 *   pnpm bench:inspect --triage              # bucket every failure vs the live workspace
 *   pnpm bench:inspect --case=<caseId>       # deep-dive ONE case (the answerer's-eye view)
 *
 * The default (listing) mode is pure file reads — no DB, no env, instant.
 * `--triage` and `--case` query the run's bench workspace, so they only work
 * while that workspace still exists: a bench run WIPES its `bench-<runId>`
 * workspace on a clean finish, so interrupt the run (Ctrl-C) if you want to
 * inspect memories afterwards. Pass `--prod` to read against `.env.production`.
 *
 * Failure buckets (`--triage` / `--case`) classify WHY a non-abstention case
 * with evidence missed, using the same as-of window the timeline scores at:
 *   - no-evidence-extracted : extractor never produced a memory from any
 *                             evidence session (extraction gap).
 *   - evidence-hidden-by-as-of : the memory exists but its valid_from/valid_until
 *                                window excludes T_retrieval (as-of cutoff gap).
 *   - visible-but-failed : evidence WAS retrievable; the miss is downstream
 *                          (ranking, formatting, or the answerer itself).
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const RUNS_ROOT = resolve(__dirname, "../runs");

const argv = process.argv.slice(2);
const isProd = argv.includes("--prod");
loadEnv({ path: resolve(repoRoot, isProd ? ".env.production" : ".env.local") });
if (process.env.BENCH_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.BENCH_DATABASE_URL;
}

function getFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

// ── Run resolution ───────────────────────────────────────────────────────────

interface Manifest {
  runId?: string;
  datasets?: string[];
  subset?: string;
  category?: string | null;
  workspaceId?: string;
  models?: Record<string, unknown>;
  counts?: { cases?: number; scored?: number };
}

interface CaseResult {
  caseId: string;
  dataset: string;
  category: string;
  question: string;
  goldAnswer: string | string[];
  abstention: boolean;
  retrievedMemoryIds: string[];
  retrievedRecallHit: boolean | null;
  retrievalCoverage?: number | null;
  modelAnswer: string;
  judgeVerdict: string;
  judgeRationale: string;
  memoryCount?: number;
}

function readLatestRunId(): string | null {
  try {
    return fs.readFileSync(path.join(RUNS_ROOT, "latest"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** List run directories newest-first by mtime. */
function listRunDirs(): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(RUNS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => {
      const ma = fs.statSync(path.join(RUNS_ROOT, a)).mtimeMs;
      const mb = fs.statSync(path.join(RUNS_ROOT, b)).mtimeMs;
      return mb - ma;
    });
}

/**
 * Read manifest.json, filling in fallbacks. The manifest is only written when
 * a run FINISHES, so an in-flight / interrupted run (the common investigation
 * target) won't have one. The per-run workspace is always `bench-<runId>`, and
 * the harness defaults to LongMemEval — derive both so --triage/--case still work.
 */
function readManifest(runId: string): Manifest {
  let m: Manifest = {};
  try {
    m = JSON.parse(
      fs.readFileSync(path.join(RUNS_ROOT, runId, "manifest.json"), "utf8"),
    ) as Manifest;
  } catch {
    /* no manifest yet — in-flight or interrupted run */
  }
  if (!m.workspaceId) m.workspaceId = `bench-${runId}`;
  if (!m.datasets || m.datasets.length === 0) m.datasets = ["longmemeval"];
  return m;
}

function readJsonl<T>(runId: string, file: string): T[] {
  try {
    return fs
      .readFileSync(path.join(RUNS_ROOT, runId, file), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

function resolveRunId(): string | null {
  const explicit = getFlag("run-id");
  if (explicit) return explicit;

  const ws = getFlag("workspace");
  if (ws) {
    for (const id of listRunDirs()) {
      if (readManifest(id).workspaceId === ws) return id;
    }
    // Fall back to deriving the runId from a `bench-<runId>` workspace id.
    const derived = ws.startsWith("bench-") ? ws.slice("bench-".length) : null;
    if (derived && fs.existsSync(path.join(RUNS_ROOT, derived))) return derived;
    return null;
  }

  return readLatestRunId() ?? listRunDirs()[0] ?? null;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;
const goldStr = (g: string | string[]) => (Array.isArray(g) ? g.join(" | ") : g);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

function isQaWin(verdict: string): boolean {
  return verdict === "correct" || verdict === "abstain_ok";
}

// ── Mode: default listing (no DB) ────────────────────────────────────────────

async function printTally(runId: string, manifest: Manifest, cases: CaseResult[]) {
  const { aggregateScores } = await import("../src/score.js");
  // cases.jsonl carries the dataset id on each row; aggregateScores groups by it.
  const scores = aggregateScores(cases as any);

  console.log(`\nRun:        ${runId}`);
  console.log(`Workspace:  ${manifest.workspaceId ?? "(unknown)"}`);
  console.log(
    `Dataset(s): ${(manifest.datasets ?? []).join(", ") || "?"}   subset: ${manifest.subset ?? "?"}${manifest.category ? `   category: ${manifest.category}` : ""}`,
  );
  console.log(`Scored:     ${cases.length} cases`);

  const qa = scores.filter((s) => s.scoreType === "qa_accuracy");
  const recall = scores.filter((s) => s.scoreType === "retrieval_recall_at_15");
  const recallByCat = new Map(recall.map((s) => [`${s.dataset}|${s.category}`, s]));

  console.log("\nPer-category (QA accuracy | retrieval recall@15):");
  const rows = qa
    .map((s) => {
      const r = recallByCat.get(`${s.dataset}|${s.category}`);
      return {
        category: s.category,
        qa: `${pct(s.score)} (${s.nCorrect}/${s.n})`,
        recall: r ? `${pct(r.score)} (${r.nCorrect}/${r.n})` : "—",
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category));
  const w = Math.max(8, ...rows.map((r) => r.category.length));
  for (const r of rows) {
    console.log(`  ${r.category.padEnd(w)}  QA ${r.qa.padEnd(14)}  recall ${r.recall}`);
  }
}

function printFailures(runId: string, cases: CaseResult[], limit: number) {
  const failures = readJsonl<{
    caseId: string;
    category: string;
    kind: string;
    question: string;
    goldAnswer: string | string[];
    modelAnswer: string;
    judgeVerdict: string;
  }>(runId, "failures.jsonl");

  // Prefer the dedicated failures.jsonl; fall back to deriving from cases.
  const derived =
    failures.length > 0
      ? failures
      : cases
          .filter((c) => !isQaWin(c.judgeVerdict) && c.judgeVerdict !== "skipped")
          .map((c) => ({
            caseId: c.caseId,
            category: c.category,
            kind: "qa",
            question: c.question,
            goldAnswer: c.goldAnswer,
            modelAnswer: c.modelAnswer,
            judgeVerdict: c.judgeVerdict,
          }));

  const byCat = new Map<string, number>();
  for (const f of derived) byCat.set(f.category, (byCat.get(f.category) ?? 0) + 1);

  console.log(`\nFailures: ${derived.length}`);
  for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${n}`);
  }

  console.log(`\nFirst ${Math.min(limit, derived.length)} failures:`);
  for (const f of derived.slice(0, limit)) {
    console.log(`\n  [${f.category}/${f.kind}] ${f.caseId}  (${f.judgeVerdict})`);
    console.log(`    Q:     ${truncate(f.question, 140)}`);
    console.log(`    gold:  ${truncate(goldStr(f.goldAnswer), 140)}`);
    console.log(`    model: ${truncate(f.modelAnswer || "(empty)", 140)}`);
  }
  console.log(
    `\n(Use --case=<caseId> for the answerer's-eye view, or --triage to bucket every failure.)`,
  );
}

// ── DB-backed helpers (triage / case) ────────────────────────────────────────

interface DbMemory {
  id: string;
  type: string;
  content: string;
  created_at: string;
  valid_from: string | null;
  valid_until: string | null;
  source_thread_ts: string | null;
  bench_provenance: { diaIds?: string[]; sessionIds?: string[] } | null;
}

async function loadWorkspaceMemories(workspaceId: string): Promise<DbMemory[]> {
  const { db } = await import("../../src/db/client.js");
  const { sql } = await import("drizzle-orm");
  const result = await db.execute(sql`
    SELECT id, type, content, created_at, valid_from, valid_until,
           source_thread_ts, bench_provenance
    FROM memories
    WHERE workspace_id = ${workspaceId}
  `);
  return ((result as any).rows ?? result) as DbMemory[];
}

/** Memories whose provenance ties them to one of the case's evidence sessions. */
function evidenceMemories(mems: DbMemory[], evidenceSessions: Set<string>): DbMemory[] {
  if (evidenceSessions.size === 0) return [];
  return mems.filter((m) => {
    if (m.source_thread_ts && evidenceSessions.has(m.source_thread_ts)) return true;
    const prov = m.bench_provenance;
    if (prov?.sessionIds?.some((s) => evidenceSessions.has(s))) return true;
    if (prov?.diaIds?.some((d) => evidenceSessions.has(d.split(":")[0]))) return true;
    return false;
  });
}

/** Was this memory inside the as-of window at instant T? Mirrors retrieve.ts. */
function visibleAsOf(m: DbMemory, t: Date): boolean {
  const from = m.valid_from ? new Date(m.valid_from).getTime() : null;
  const until = m.valid_until ? new Date(m.valid_until).getTime() : null;
  const T = t.getTime();
  if (from != null && from > T) return false;
  if (until != null && until <= T) return false;
  return true;
}

type Bucket = "no-evidence-extracted" | "evidence-hidden-by-as-of" | "visible-but-failed";

async function buildCaseIndex(datasets: string[]) {
  const { loadDataset } = await import("../src/fixtures.js");
  const index = new Map<string, any>();
  const known = new Set(["toy", "longmemeval", "locomo"]);
  const ids = (datasets.length > 0 ? datasets : ["longmemeval"]).filter((d) =>
    known.has(d),
  );
  for (const d of ids) {
    for (const c of await loadDataset(d as any)) index.set(c.id, c);
  }
  return index;
}

function caseEvidenceSessions(benchCase: any): Set<string> {
  const set = new Set<string>(benchCase.evidenceSessionIds ?? []);
  for (const d of benchCase.evidenceDiaIds ?? []) set.add(d.split(":")[0]);
  return set;
}

function bucketFor(
  benchCase: any,
  mems: DbMemory[],
  retrievalInstant: Date,
): Bucket {
  const evidence = caseEvidenceSessions(benchCase);
  const evMems = evidenceMemories(mems, evidence);
  if (evMems.length === 0) return "no-evidence-extracted";
  const anyVisible = evMems.some((m) => visibleAsOf(m, retrievalInstant));
  return anyVisible ? "visible-but-failed" : "evidence-hidden-by-as-of";
}

async function runTriage(runId: string, manifest: Manifest, cases: CaseResult[]) {
  const workspaceId = manifest.workspaceId;
  if (!workspaceId) {
    console.error("No workspaceId in manifest — can't triage. Pass --workspace=<id>.");
    process.exit(1);
  }
  const { resolveQuestionDate } = await import("../src/fixtures.js");
  const mems = await loadWorkspaceMemories(workspaceId);
  if (mems.length === 0) {
    console.error(
      `\nWorkspace ${workspaceId} has 0 memories — it was likely wiped on a clean run finish.\n` +
        `Triage needs the live workspace: interrupt the run (Ctrl-C) instead of letting it complete.`,
    );
    process.exit(1);
  }
  console.log(`\nWorkspace ${workspaceId}: ${mems.length} memories\n`);

  const index = await buildCaseIndex(manifest.datasets ?? []);
  const failures = cases.filter(
    (c) => !isQaWin(c.judgeVerdict) && c.judgeVerdict !== "skipped" && !c.abstention,
  );

  const buckets = new Map<Bucket, CaseResult[]>([
    ["no-evidence-extracted", []],
    ["evidence-hidden-by-as-of", []],
    ["visible-but-failed", []],
  ]);
  const unknown: CaseResult[] = [];

  for (const f of failures) {
    const benchCase = index.get(f.caseId);
    if (!benchCase || caseEvidenceSessions(benchCase).size === 0) {
      unknown.push(f);
      continue;
    }
    const t = resolveQuestionDate(benchCase);
    buckets.get(bucketFor(benchCase, mems, t))!.push(f);
  }

  console.log(`Triaged ${failures.length} non-abstention failures with evidence:\n`);
  for (const [bucket, list] of buckets) {
    console.log(`${bucket}: ${list.length}`);
    const byCat = new Map<string, number>();
    for (const f of list) byCat.set(f.category, (byCat.get(f.category) ?? 0) + 1);
    for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${cat}: ${n}`);
    }
    for (const f of list.slice(0, 8)) {
      console.log(`   - ${f.caseId}  ${truncate(f.question, 90)}`);
    }
    console.log("");
  }
  if (unknown.length > 0) {
    console.log(
      `(${unknown.length} failures had no evidence pointers / weren't in the corpus index — not bucketed.)`,
    );
  }
}

// ── Mode: single-case deep dive ──────────────────────────────────────────────

async function runCase(runId: string, manifest: Manifest, cases: CaseResult[]) {
  const caseId = getFlag("case")!;
  const workspaceId = manifest.workspaceId;
  if (!workspaceId) {
    console.error("No workspaceId in manifest — can't deep-dive. Pass --workspace=<id>.");
    process.exit(1);
  }

  const { resolveQuestionDate } = await import("../src/fixtures.js");
  const { evaluateRetrieval } = await import("../src/eval-retrieval.js");
  const { formatMemoriesForPrompt } = await import(
    "../../src/memory/format-for-prompt.js"
  );
  const { formatConversations } = await import(
    "../../src/personality/system-prompt.js"
  );
  const { retrieveConversations } = await import(
    "../../src/memory/retrieve.js"
  );

  const index = await buildCaseIndex(manifest.datasets ?? []);
  const benchCase = index.get(caseId);
  if (!benchCase) {
    console.error(
      `Case ${caseId} not found in dataset(s) ${(manifest.datasets ?? []).join(", ")}.`,
    );
    process.exit(1);
  }

  const recorded = cases.find((c) => c.caseId === caseId);
  const referenceNow = resolveQuestionDate(benchCase);
  // Strict bi-temporal as-of == the question instant (same as production).
  const retrievalInstant = referenceNow;
  const k = getFlag("k") ? Number(getFlag("k")) : 15;

  console.log(`\nCase:            ${caseId}  [${benchCase.category}]`);
  console.log(`Question:        ${benchCase.question}`);
  console.log(`Gold:            ${goldStr(benchCase.goldAnswer)}`);
  if (recorded) {
    console.log(`Model answer:    ${recorded.modelAnswer || "(empty)"}`);
    console.log(`Verdict:         ${recorded.judgeVerdict}`);
    console.log(`Judge rationale: ${truncate(recorded.judgeRationale, 200)}`);
  }
  console.log(`Reference now:   ${referenceNow.toISOString()}  (answerer's "today")`);
  console.log(`Retrieval as-of: ${retrievalInstant.toISOString()}`);

  // Re-run retrieval both as-of and against the live pool, side by side.
  const asOfRes = await evaluateRetrieval(benchCase, workspaceId, k, undefined, retrievalInstant);
  const liveRes = await evaluateRetrieval(benchCase, workspaceId, k, undefined, undefined);

  const fmtCov = (r: { coverage: number | null; coveredSessions: number; evidenceSessions: number }) =>
    r.coverage == null
      ? "n/a (no evidence pointers)"
      : `${pct(r.coverage)} (${r.coveredSessions}/${r.evidenceSessions} sessions)`;
  console.log(`\nRetrieval coverage  as-of: ${fmtCov(asOfRes)}   live: ${fmtCov(liveRes)}`);

  // The literal memory block the constrained answerer saw (as-of retrieval,
  // anchored to the answerer's referenceNow). This is the production wire format.
  const block = formatMemoriesForPrompt(asOfRes.retrieved, referenceNow);
  console.log("\n── Memory block the answerer saw (as-of) ─────────────────────────");
  console.log(block || "(no memories available)");

  // The <related_threads> pointers the answerer also sees — the SAME prod path
  // (retrieveConversations), scoped to the retrieval instant.
  const conversations = await retrieveConversations({
    query: benchCase.question,
    workspaceId,
    asOf: retrievalInstant,
    threadLimit: 3,
    matchLimit: 15,
    minSimilarity: 0.35,
  });
  console.log(`\n── Related threads the answerer saw (${conversations.length}) ───────────`);
  console.log(formatConversations(conversations) || "(none retrieved)");

  // What's in the workspace for the evidence sessions, with visibility flags —
  // distinguishes an extraction gap from an as-of cutoff gap.
  const mems = await loadWorkspaceMemories(workspaceId);
  const evidence = caseEvidenceSessions(benchCase);
  const evMems = evidenceMemories(mems, evidence);
  console.log(
    `\n── Evidence-session memories in workspace (${evMems.length}) ──────────────`,
  );
  if (evidence.size === 0) {
    console.log("(case has no evidence pointers)");
  } else if (evMems.length === 0) {
    console.log(
      `NONE — extractor produced no memory from evidence sessions {${[...evidence].join(", ")}} (extraction gap).`,
    );
  } else {
    const retrievedIds = new Set(asOfRes.retrievedMemoryIds);
    for (const m of evMems) {
      const vis = visibleAsOf(m, retrievalInstant) ? "visible" : "HIDDEN-by-as-of";
      const got = retrievedIds.has(m.id) ? "retrieved" : "not-retrieved";
      console.log(
        `  [${m.type}] ${truncate(m.content, 100)}\n      valid_from=${m.valid_from ?? "null"} valid_until=${m.valid_until ?? "null"}  → ${vis}, ${got}`,
      );
    }
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────

async function main() {
  const runId = resolveRunId();
  if (!runId) {
    console.error(
      `No bench run found under ${RUNS_ROOT}. Run \`pnpm bench:memory …\` first, or pass --run-id=<id>.`,
    );
    process.exit(1);
  }
  const manifest = readManifest(runId);
  const cases = readJsonl<CaseResult>(runId, "cases.jsonl");

  if (getFlag("case")) {
    await runCase(runId, manifest, cases);
  } else if (hasFlag("triage")) {
    await runTriage(runId, manifest, cases);
  } else {
    await printTally(runId, manifest, cases);
    const limit = getFlag("limit") ? Number(getFlag("limit")) : 20;
    printFailures(runId, cases, limit);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
