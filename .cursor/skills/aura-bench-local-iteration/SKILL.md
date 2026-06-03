---
name: aura-bench-local-iteration
description: Fast local memory-bench iteration loop for Cursor Cloud Agents — run a mid-size LongMemEval (n=10/category) against the agent's own Neon DB in ~10–30 min, then inspect failures and the actual stored memories to iterate quickly. Use when developing/debugging a memory change and the toy corpus is too small but a full medium run (CI/~2h) is too slow.
---

# Aura memory bench — local fast-iteration loop (Cloud Agent)

The conceptual model, corpora, timeline, cost gates, and CI flow live in the
`aura-memory-bench` skill + rule. **This skill is the operational loop a Cursor
Cloud Agent uses to iterate on a memory change without waiting ~2h for CI.**

## Why this exists (the gap)

| Tier | Size | Time | Use |
|---|---|---|---|
| `toy` | ~5 Qs | ~1 min | plumbing smoke only — too small to see real failure modes |
| **mid (`--limit=10`)** | **~60 Qs (10/category)** | **~10–30 min** | **the sweet spot: real signal + fast enough to inspect & iterate** |
| `medium` | ~180 Qs (30/cat) | ~1.5–2.5h, ~$13 | authoritative number — let **CI** run it |
| `full` | 2,486 Qs | hours, real $ | manual, ask the user |

A Cloud Agent already has `DATABASE_URL` (Neon), `AI_GATEWAY_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NEON_API_KEY`/`NEON_PROJECT_ID` injected
into its env. That means it can **run the bench locally end-to-end and inspect
the real DB** — the thing CI can't give you, because CI wipes its workspace.

## The loop

### 0. One-time setup
```bash
pnpm install --frozen-lockfile
pnpm --filter aura-api bench:fetch-corpus   # vendors LongMemEval + LoCoMo into bench/corpus/cache
```

### 1. Run the mid-size pass into a PERSISTENT workspace
The `env.sh` wrapper needs `.env.local`, which a Cloud Agent VM doesn't have —
the vars are already in the process env, so call the script directly via `tsx`:
```bash
cd apps/api && pnpm exec tsx src/scripts/bench-memory.ts \
  --dataset=lme --limit=10 \
  --bench-id=<key> \                 # PERSISTENT workspace (not wiped) → inspectable after
  --concurrency=4 --score-concurrency=8 \
  --json=/tmp/bench/result.json > /tmp/bench/run.log 2>&1
```
- `--limit=10` caps cases **per category** (6 categories → ~60 Qs). Use 8–12 to trade speed for signal.
- `--bench-id=<key>` pins workspace `bench-local-<key>` and **does not wipe it** on finish (an ephemeral run, i.e. no `--bench-id`, wipes — then `--triage`/`--case` can't query memories).
- **Do NOT pass `--log`** for debug runs — it pollutes `history.jsonl`. (The README-snapshot guard already refuses non-medium/full LongMemEval, but skip `--log` anyway.)
- **Always run it backgrounded** (tmux / `block_until_ms: 0`); never block the turn on it. Poll the log for `bench: extract N/M` and `bench: score N/M`.

### 2. Read the per-category scores
The summary table prints at the end of the log (QA accuracy + recall@15 per
category). `partial` judge verdicts score **0.5**, `correct`/`abstain_ok` score 1.

### 3. Triage the failures against the live workspace
```bash
pnpm exec tsx bench/scripts/inspect-run.ts --run-id=<runId> --triage
```
Buckets every non-abstention failure:
- **`no-evidence-extracted`** → extraction problem (the fact never became a memory).
- **`evidence-hidden-by-as-of`** → bi-temporal/timeline problem (fact exists but not valid yet at question time).
- **`visible-but-failed`** → retrieval surfaced it but the answer was still wrong → **answer-step / dilution / judge** problem.

### 4. Deep-dive a case (answerer's-eye view)
```bash
pnpm exec tsx bench/scripts/inspect-run.ts --run-id=<runId> --case=<caseId>
```
Shows the exact memory block + `<related_threads>` the answerer saw, the gold vs
model answer, and which evidence-session memories exist/were retrieved as-of.

### 5. Inspect the actual stored memories in the DB
The persistent workspace is queryable directly. `tsx -e` can't do top-level
await — write a tiny temp script:
```ts
// _q.ts (delete after)
import { db } from "./src/db/client.js";
import { sql } from "drizzle-orm";
(async () => {
  const r: any = await db.execute(sql`
    SELECT extraction_source_role AS role, count(*) FROM memories
    WHERE workspace_id='bench-local-<key>' GROUP BY 1 ORDER BY 2 DESC`);
  console.log(r.rows ?? r); process.exit(0);
})();
```
```bash
cp _q.ts apps/api/_q.ts && (cd apps/api && pnpm exec tsx _q.ts); rm apps/api/_q.ts
```
Useful checks: count by `extraction_source_role` (watch for assistant-memory
over-extraction crowding out user facts), `avg(length(content))`, full content
of the memories for a failed case's evidence session.

### 6. Iterate → re-run
After a code/prompt change, re-run with a **fresh** `--bench-id` (or add
`--reset` to wipe and re-extract the same key) so memories reflect the new code.

### 7. Clean up (IMPORTANT)
The persistent workspace lives in the agent's Neon DB. Delete it when done
(respect FK order):
```ts
for (const ws of ["bench-local-<key>"]) {
  await db.execute(sql`DELETE FROM memory_entities WHERE memory_id IN (SELECT id FROM memories WHERE workspace_id=${ws})`);
  await db.execute(sql`DELETE FROM memories WHERE workspace_id=${ws}`);
  await db.execute(sql`DELETE FROM messages WHERE workspace_id=${ws}`);
  await db.execute(sql`DELETE FROM entities WHERE workspace_id=${ws}`);
  await db.execute(sql`DELETE FROM workspaces WHERE id=${ws}`);
}
```

## LoCoMo fast loop (seed once, score a curated subset)

A full LoCoMo run is ~105 min / ~$70, but almost all of that is re-extracting
the 10 conversations (~3,075 per-reply units). Every LoCoMo failure mode lives
**downstream of extraction** (over-abstention, multi-hop partial coverage,
temporal rendering, retrieval whiffs), so when you're iterating on
retrieval/ranking/answerer/temporal-format changes you should **never
re-extract**. Two existing primitives, no new machinery:

1. **Seed ONCE** — extract all 10 conversations into a persistent workspace
   (`--to=extract` skips scoring; bounded by the longest conversation's serial
   extraction, ~45–60 min one time):
   ```bash
   cd apps/api && pnpm exec tsx src/scripts/bench-memory.ts \
     --dataset=locomo --subset=full --bench-id=locomo --reset --to=extract --concurrency=10
   ```
2. **Iterate** — score a curated 250-case subset against those memories, no
   extraction (~5–10 min, ~$8):
   ```bash
   pnpm --filter aura-api bench:locomo-fast --emit            # writes /tmp/locomo-fast-corpus.json
   cd apps/api && pnpm exec tsx src/scripts/bench-memory.ts \
     --corpus-file=/tmp/locomo-fast-corpus.json --from=score --bench-id=locomo
   ```

**Why `--from=score` is faithful for LoCoMo:** LoCoMo questions resolve to
end-of-conversation (`resolveQuestionDate` → `endOfConversationInstant`), so the
as-of retrieval instant already includes every memory the conversation produced.
With extraction complete, each question retrieves bit-identically to a full run —
the extraction frontier only changes *when* a question releases, never *what* it
sees (`timeline.ts` `isReleasable`/`scoreOne`). After an **extraction or schema**
change, re-seed with `--from=extract` (reuses messages, re-extracts) before
scoring.

**The curated subset** (`bench/fast/locomo-fast.json`, built by
`bench/scripts/build-locomo-fast.ts`) is a stratified seeded sample, 50/category,
that (a) reproduces the full run's **per-category** QA within ±2pp and (b)
guarantees coverage of every failure bucket (`over_abstain`, `answerer_wrong`,
`partial_coverage`, `zero_coverage`, plus `pass`/`partial_credit` controls to
catch regressions). Read per-**category** deltas, not the blended overall — the
subset is category-balanced while the full set is open_domain-heavy, so the
blended overall is a few pp lower by construction. Regenerate the selection from
a fresh full run with `pnpm --filter aura-api bench:locomo-fast --select`.

## Isolation: workspace-id vs Neon branch
- **Default (what this loop uses):** logical isolation by `workspace_id`
  (`bench-local-<key>`) on the agent's existing Neon DB. Simple, fast, cleaned
  up in step 7. Safe because every query is workspace-scoped and CI uses its own
  forked branch (never this DB).
- **Stronger isolation (optional):** fork a real Neon branch via the Neon MCP /
  `NEON_API_KEY`, point `DATABASE_URL` at it, run, then delete the branch. Use
  when you don't want any writes touching the agent's main dev DB.

## Pulling a CI run's artifacts to inspect locally
CI wipes its workspace, but uploads `cases.jsonl` / `failures.jsonl` / `run.log`.
```bash
gh run download <runId> -n memory-bench-lme-<runId> -D /tmp/benchrun
cp -r /tmp/benchrun/.../bench/runs/<runId> apps/api/bench/runs/   # then inspect-run --run-id
```
`--triage`/`--case` need the live workspace (gone), but the default
tally + failure list and `cases.jsonl` cross-referencing still work, and you can
reproduce a specific memory interaction in a throwaway workspace.

## Performance notes (so you set expectations)
- Local Cloud Agent VM ≈ 4 vCPU / 15 GB. The bench is **LLM-API-bound**, not CPU-
  bound — `--concurrency` (extraction) and `--score-concurrency` (answer+judge)
  matter far more than cores; bounded by AI-gateway / Anthropic rate limits.
- Defaults: extract=4, score=8, embed=4 (same as CI). Bumping score-concurrency
  speeds the answer/judge stage until you hit 429s.
- **Bigger memory pools slow the score stage super-linearly** (rerank runs over
  every candidate). If a run is crawling, check for memory over-extraction first
  (step 5) — fewer, higher-quality memories is faster *and* better.
