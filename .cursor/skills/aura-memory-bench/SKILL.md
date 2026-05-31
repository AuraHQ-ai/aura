---
name: aura-memory-bench
description: Run and interpret Aura's memory benchmark (toy/LongMemEval/LoCoMo corpora). Use when running `pnpm bench:memory`, evaluating memory extraction/retrieval/QA quality, iterating on a memory change, or debugging knowledge_update/temporal/multi_hop/abstention scores.
---

# Aura Memory Benchmark

End-to-end harness that replays corpus conversations through the real
extractor → memory pipeline on a **production-faithful timeline**, then scores
**retrieval recall@15** (deterministic, no LLM) and **QA accuracy**
(constrained answerer + LLM judge).

- CLI entry: `apps/api/src/scripts/bench-memory.ts`
- Orchestrator: `apps/api/bench/src/runner.ts`
- Timeline engine: `apps/api/bench/src/timeline.ts`
- Corpora: `apps/api/bench/corpus/` (toy is always vendored)

## The timeline model (how this mirrors production)

The bench does **not** run three sequential stages (store all → extract all →
score all against the final pool). It runs a single global timeline that mirrors
prod end to end:

- **Messages arrive over corpus time** and extraction runs as they arrive —
  per assistant reply over a sliding 30-message window (`exchange` cadence, the
  default), exactly like prod's incremental reconciliation.
- **Questions arrive over time too.** A question asked at instant `T_Q` is
  scored the moment the **global extraction watermark** (the min next-unextracted
  reply timestamp across every conversation) passes `T_Q` — guaranteeing every
  globally-earlier reply is already reconciled.
- **Retrieval is bi-temporal "as-of `T_Q`"**: it returns the memory state that
  was valid at that instant (`valid_from <= T_Q AND (valid_until IS NULL OR
  valid_until > T_Q)`), so a fact superseded *later* is still visible and one
  superseded *earlier* is gone. This closes the old "questions see the future"
  leak (a `knowledge_update` question retrieving the post-update memory) and
  keeps scoring deterministic even though the producer (extraction) races ahead
  of and overlaps the consumer (scoring). Pass `--no-as-of` to score against the
  live final pool instead (the old behaviour).

`--dataset=lme` (LongMemEval) is the default because it ships **real question
timestamps**. LoCoMo/toy have none, so their questions fall back to
"asked at end of conversation" (watermark after all that conversation's turns) —
the same graceful degradation, still runnable for the smoke path.

## Run it

Always run from the **repo root** (the root script loads `.env.local` via
`scripts/env.sh`). Needs a live `DATABASE_URL` and AI Gateway access. To keep
bench fixtures off dev/prod, set `BENCH_DATABASE_URL` (e.g. a Neon "bench"
branch) and the whole bench process uses it instead of `DATABASE_URL`.

```bash
pnpm bench:memory                              # LongMemEval, medium subset (the default)
pnpm bench:memory --dataset=toy                # tiny vendored smoke test (~1 min)
pnpm bench:memory --dataset=both --subset=fast # LoCoMo + LongMemEval, ~40 Qs
pnpm bench:memory --replay=session             # cheap dev-only cadence (one extraction/session)
pnpm bench:memory --dry-run                    # validate plumbing, no DB writes / no LLM calls
```

The toy run takes ~1 minute, costs a few cents, ingests 5 cases across
5 categories (single_hop, multi_hop, temporal, knowledge_update, abstention),
and prints a QA + recall table. It creates and then wipes a scratch
workspace (`bench-<runId>`), so it never touches real workspace data.

> **Baseline reset (one-time):** the timeline + as-of model and the `exchange`
> default change both the corpus shape and retrieval strictness, so the first
> run after this lands shows a one-time `history.jsonl` delta (expect movement
> on `temporal` and `knowledge_update`). That's expected, not a regression.

## Cost, runtime, and how to run it (esp. from an agent)

The bench runs **in CI on memory-relevant PRs**: the action does the medium
LongMemEval (`--dataset=lme`, `--replay=exchange`) pass on an isolated Neon
branch, posts a sticky PR comment with per-category deltas vs the target branch,
and commits the regenerated `history.jsonl` + READMEs back to the PR branch
(pushed with `GITHUB_TOKEN`, so it doesn't retrigger CI). See
`.github/workflows/memory-bench.yml`. Locally is the fast iteration loop; how you
run it depends on size, because a full run is slow and costs real money:

| Run | Command | Time | Cost | Who runs it |
|---|---|---|---|---|
| Smoke | `--dataset=toy --log` | ~1 min | cents | agent (background) |
| Iteration | `--dataset=lme --subset=fast --log` | a few min | ~$2 | agent (background) |
| Standard | `--dataset=lme --subset=medium --log` | ~1 hour (~330 Qs) | ~$10 | CI on the PR (don't run locally) |
| Full | `--dataset=lme --subset=full --log` | ~2–3 hours (2,486 Qs) | real money | ask the user (manual dispatch) |

Note: `exchange` cadence fires one extraction per assistant reply (~turns/2× more
LLM calls than `session`), so wall-clock is held down by the **overlap** —
`--concurrency` extraction (producer) workers run concurrently with
`--score-concurrency` scoring (consumer) workers, gated only by the watermark.

**Never block a turn on a bench run.** Don't pipe it through `tail`/`head`/`tee`
in a foreground shell call — a full run can take an hour and will hang. Launch
cheap runs as fire-and-forget background jobs (`block_until_ms: 0`) and rely on
the completion notification. For medium/full runs, hand the user the exact
command and let them run it — then commit the regenerated `history.jsonl` +
READMEs. The run is resume-safe (`--resume`) and Ctrl-C drains + saves partial
results, so a long run interrupted partway isn't wasted.

## Reusing ingested data (persistent workspaces)

By default every run uses a throwaway workspace (`bench-<runId>`) that is wiped
at the end — so a medium run re-ingests **and re-extracts everything** (the
extract stage alone can take >70 min) and then throws it away. To iterate
without paying that cost each time, pin a **persistent** workspace with
`--bench-id` and reuse the expensive stages via `--from`.

The pipeline has three stages — `messages` (store + embed raw turns) → `extract`
(LLM extraction into memories) → `score` (retrieval + answerer + judge). What
`--from` reuses, and what invalidates the reuse:

| Command | Reuses | Re-runs | Use after you changed… |
|---|---|---|---|
| `--bench-id=X --from=messages` (default) | nothing | everything | the corpus, or the embedding model |
| `--bench-id=X --from=extract` | stored messages | extraction + score | extraction logic or the memory **schema** (e.g. a new column) |
| `--bench-id=X --from=score` | messages + memories | retrieval + QA only | retrieval / fusion / answerer / judge only |

Recommended loop for a retrieval/answer change against a stable corpus:

```bash
# 1. Seed once (full ingest into a persistent workspace, ~1h, ask the user):
pnpm bench:memory --dataset=both --subset=medium --bench-id=phase2 --log
# 2. Iterate cheaply (reuse messages + memories, only retrieval + QA re-run):
pnpm bench:memory --bench-id=phase2 --from=score --log
# 3. After an extraction or schema change, re-extract but keep the messages:
pnpm bench:memory --bench-id=phase2 --from=extract --log
```

Invalidation rules of thumb: a **schema/extraction** change invalidates persisted
*memories* (use `--from=extract`); an **embedding-model or corpus** change
invalidates persisted *messages* too (use `--from=messages` / `--reset`). The
embedding model and corpus hash are stamped on every `bench_runs` row so you can
tell when a reuse would be stale.

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
- `--log` appends a structured entry to `apps/api/bench/history.jsonl` and
  regenerates `apps/api/bench/README.md` + the snapshot block in the root
  `README.md` (pair with `--note="…"`). Skipped on `--dry-run`.
- `pnpm bench:report` regenerates both markdown views from `history.jsonl`
  without running the bench (no DB / LLM needed) — handy after a rebase or a
  manual history edit.

## Convention: CI logs + commits results on the PR (don't hand-paste numbers)

Any change that can move the numbers (memory extraction, retrieval,
reconciliation, scoring, corpus) is validated **on the PR by CI**:

1. Make the change and verify it (`pnpm typecheck`).
2. Optionally sanity-check locally on the cheap subsets while iterating:
   `pnpm bench:memory --dataset=toy --log` or `--subset=fast` (see the table above).
   Don't run medium/full locally — that's CI's job.
3. Open the PR. The **Memory bench** action runs the medium pass, posts a sticky
   comment with per-category deltas vs the target branch, and **commits the
   regenerated `apps/api/bench/history.jsonl` + `apps/api/bench/README.md` + root
   `README.md` snapshot to your PR branch** (one squashed entry per PR, keyed by
   `prNumber`). Those real numbers merge into `main` with the PR.

If a category regresses by more than 2pp the comment flags it and you must
justify it in the PR description.

For *local* `--log` runs the entry records the current `git rev-parse HEAD`;
running before the commit exists stamps it `<sha>-dirty`. `pnpm bench:report`
regenerates the markdown views from `history.jsonl` with no DB/LLM (handy after
a rebase or manual history edit).

## Useful flags

| Flag | Effect |
|---|---|
| `--dataset=` | `lme` (default), `toy`, `locomo`, `both`, `all` |
| `--subset=` | `fast` (~4/cat), `medium` (~30/cat, default), `full` (no cap, costly) |
| `--replay=` | `exchange` (default, prod-faithful per-reply) or `session` (cheap dev-only) |
| `--limit=N` | per-category cap, overrides `--subset` |
| `--category=` | filter to one category |
| `--concurrency=N` | extraction (producer) workers (default 4) |
| `--score-concurrency=N` | scoring (consumer) workers, overlaps extraction (default 8) |
| `--no-as-of` | disable bi-temporal retrieval — score against the live final pool |
| `--json=PATH` | write detailed per-case results |
| `--dry-run` | no DB writes, no LLM calls |
| `--skip-ingest` | reuse already-ingested memories for this runId |
| `--bench-id=KEY` | pin a persistent workspace (`bench-local-KEY`) that survives between runs, so `--from` can reuse its data |
| `--from=` / `--to=` | stage window: `messages` → `extract` → `score`. `--from=score` reuses messages + memories; `--from=extract` reuses messages (see "Reusing ingested data") |
| `--reset` | wipe the persistent workspace's data before running (start the `--bench-id` workspace from scratch) |
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

The **"Δ vs prior"** column only compares against the newest prior run with the
**same corpus hash and the exact same sampled case set** — `computeDeltas` in
`bench/src/score.ts` filters `bench_runs` on `corpusHash` + `caseSetHash`
(the sha of the sampled `source/id/category` set). This is deliberate: a `fast`
run has n≈4/category while a `medium` run has n≈30, so the case sets differ and
diffing fast-against-medium would be a fake regression. When there's no
comparable prior run (first run for that corpus + case set), every delta cell
shows `—` — not a regression, just no baseline. To get a real before/after, run
the **same subset/corpus** as your baseline.

### Diagnosing a 0% category

1. Re-run that category alone with `--json`:
   `pnpm bench:memory --dataset=toy --category=<name> --json=/tmp/b.json`
2. **A category that passes in isolation but fails in a full run is almost
   always cross-case ingest interference, not a model problem.** The bench
   de-dupes conversations before ingest by hashing each case's full session
   payload (`conversationKey` in `bench/src/ingest.ts`). If two cases share
   identical session content they collapse to one ingest — intended for
   LoCoMo's many-QA-per-conversation layout. Confirm the run log line
   `bench: extracting memories from N unique conversation(s) of M case(s)`
   shows the expected unique count.
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
| Timeline engine (producer/consumer + watermark) | `apps/api/bench/src/timeline.ts` |
| Corpus loaders + sampling + `resolveQuestionDate` | `apps/api/bench/src/fixtures.ts` |
| Ingest + extraction units + conversation de-dupe | `apps/api/bench/src/ingest.ts` |
| Bi-temporal as-of retrieval | `apps/api/src/memory/retrieve.ts` (`asOf` option) |
| Retrieval recall scoring | `apps/api/bench/src/eval-retrieval.ts` |
| QA answerer + judge | `apps/api/bench/src/eval-qa.ts` |
| Score aggregation / persistence | `apps/api/bench/src/score.ts` |
| History + markdown generation | `apps/api/bench/src/results-log.ts` |
| Markdown regen script (`bench:report`) | `apps/api/bench/scripts/report.ts` |
| Structured run history (source of truth) | `apps/api/bench/history.jsonl` |
| Generated detailed results | `apps/api/bench/README.md` |
| PR delta baseline + diff + comment render | `apps/api/bench/src/pr-delta.ts` |
| PR comment orchestration (CI) | `apps/api/bench/scripts/pr-comment.ts` |
| CI: PR runs (auto on memory paths) + manual dispatch | `.github/workflows/memory-bench.yml` |
