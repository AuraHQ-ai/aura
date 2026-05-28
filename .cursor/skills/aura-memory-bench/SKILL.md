---
name: aura-memory-bench
description: Run and interpret Aura's memory benchmark (toy/LongMemEval/LoCoMo corpora). Use when running `pnpm bench:memory`, evaluating memory extraction/retrieval/QA quality, iterating on a memory change, or debugging knowledge_update/temporal/multi_hop/abstention scores.
---

# Aura Memory Benchmark

End-to-end harness that ingests corpus conversations through the real
extractor → memory pipeline, then scores **retrieval recall@15** (deterministic,
no LLM) and **QA accuracy** (constrained answerer + LLM judge).

- CLI entry: `apps/api/src/scripts/bench-memory.ts`
- Orchestrator: `apps/api/bench/src/runner.ts`
- Corpora: `apps/api/bench/corpus/` (toy is always vendored)

## Run it

Always run from the **repo root** (the root script loads `.env.local` via
`scripts/env.sh`). Needs a live `DATABASE_URL` and AI Gateway access.

```bash
pnpm bench:memory                              # toy corpus, medium subset (the smoke test)
pnpm bench:memory --dataset=lme                # LongMemEval (must be fetched first)
pnpm bench:memory --dataset=both --subset=fast # LoCoMo + LongMemEval, ~40 Qs
pnpm bench:memory --dry-run                    # validate plumbing, no DB writes / no LLM calls
```

The toy run takes ~1 minute, costs a few cents, ingests 5 cases across
5 categories (single_hop, multi_hop, temporal, knowledge_update, abstention),
and prints a QA + recall table. It creates and then wipes a scratch
workspace (`bench-<runId>`), so it never touches real workspace data.

## Iterating on a memory change

Ramp data up in small steps on the axis you're fixing — don't jump to the full set:

```bash
pnpm bench:memory --dataset=lme --category=temporal --limit=3
pnpm bench:memory --dataset=lme --category=temporal --limit=10 --log
```

- `--category=<name>` filters to one category.
- `--limit=N` caps cases per category (overrides `--subset`).
- `--json=/tmp/out.json` dumps per-case `modelAnswer`, `judgeVerdict`,
  `judgeRationale`, and `retrievedMemoryIds` — **this is the first thing to
  reach for when a category scores 0%.**
- `--log` appends a commit-stamped fingerprint to `apps/api/bench/RESULTS.md`
  (pair with `--note="…"`). Skipped on `--dry-run`.

## Convention: log + commit results with every memory change (REQUIRED)

Any change that can move the numbers (memory extraction, retrieval,
reconciliation, scoring, corpus) must ship with a fresh fingerprint:

1. Make the change and verify it (`pnpm typecheck`).
2. Run the relevant bench with `--log --note="<what changed + score deltas>"`.
   For a quick memory change the toy run is enough: `pnpm bench:memory --log --note="…"`.
3. Commit the code change **and** the `apps/api/bench/RESULTS.md` entry in the
   **same commit**, so every commit carries the scores it produced.

The fingerprint records the current `git rev-parse HEAD`. Because step 2 runs
before the commit exists, the entry is stamped `<sha>-dirty` — that's expected
and honest (it means the run included uncommitted changes). If you need the
entry to carry the *final* commit SHA, commit the code first, re-run `--log` on
the clean tree, then amend `RESULTS.md` into the commit.

## Useful flags

| Flag | Effect |
|---|---|
| `--dataset=` | `toy` (default), `lme`, `locomo`, `both`, `all` |
| `--subset=` | `fast` (~4/cat), `medium` (~30/cat, default), `full` (no cap, costly) |
| `--limit=N` | per-category cap, overrides `--subset` |
| `--category=` | filter to one category |
| `--concurrency=N` | parallel ingest workers (default 2) |
| `--json=PATH` | write detailed per-case results |
| `--dry-run` | no DB writes, no LLM calls |
| `--skip-ingest` | reuse already-ingested memories for this runId |
| `--corpus-file=PATH` | load a normalized `BenchCase[]` JSON directly |
| `--extraction-model=` / `--answerer-model=` / `--judge-model=` | model id (e.g. `anthropic/claude-sonnet-4.6`) or tier (`fast`/`main`/`escalation`) |
| `--prod` | use `.env.production` instead of `.env.local` |

## Reading the results

Two independent signals — always check both, they fail for different reasons:

- **Retrieval recall@15** — did the retriever surface a memory from an
  evidence session? Pure set-membership, no LLM. Low recall → extraction or
  retrieval problem.
- **QA accuracy** — did the answerer produce the gold answer (per the judge)?
  Low QA *despite* high recall → answering/judging problem.

### Diagnosing a 0% category

1. Re-run that category alone with `--json`:
   `pnpm bench:memory --dataset=toy --category=<name> --json=/tmp/b.json`
2. **A category that passes in isolation but fails in a full run is almost
   always cross-case ingest interference, not a model problem.** The bench
   de-dupes conversations before ingest by hashing each case's full session
   payload (`conversationKey` in `bench/src/ingest.ts`). If two cases share
   identical session content they collapse to one ingest — intended for
   LoCoMo's many-QA-per-conversation layout. Confirm the run log line
   `bench: ingesting N unique conversation(s) from M case(s)` shows the
   expected unique count.
3. Inspect `modelAnswer` + `judgeRationale` in the JSON for answerer/judge
   issues (format strictness, stale-vs-updated facts).

### Known sharp edge: recall@15 after a knowledge update

`benchProvenance` and `sourceThreadTs` are stamped only at memory **create**
time (`apps/api/src/memory/extract.ts`), never refreshed when reconciliation
**updates** a memory. For `knowledge_update` cases (e.g. MongoDB → Postgres),
the answer-bearing memory keeps the *creating* session's provenance, so the
recall scorer can't credit the *updating* evidence session — QA can be 100%
while recall@15 reads 0%. This is a metric limitation, not a retrieval
regression. Judge it against QA accuracy.

## Where things live

| Concern | File |
|---|---|
| CLI / flags | `apps/api/src/scripts/bench-memory.ts` |
| Orchestration | `apps/api/bench/src/runner.ts` |
| Corpus loaders + sampling | `apps/api/bench/src/fixtures.ts` |
| Ingest + conversation de-dupe | `apps/api/bench/src/ingest.ts` |
| Retrieval recall scoring | `apps/api/bench/src/eval-retrieval.ts` |
| QA answerer + judge | `apps/api/bench/src/eval-qa.ts` |
| Score aggregation / persistence | `apps/api/bench/src/score.ts` |
| Nightly cron | `apps/api/src/cron/bench-memory.ts` |
| Historical fingerprints | `apps/api/bench/RESULTS.md` |
