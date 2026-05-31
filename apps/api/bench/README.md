# Memory bench results

<!-- Generated from history.jsonl by `pnpm bench:memory … --log` / `pnpm bench:report`. Do not edit by hand. -->

The memory bench replays vendored LongMemEval (default) / LoCoMo corpora through
Aura's real `extract → retrieve → answer` pipeline on a production-faithful timeline:
per-assistant-reply extraction runs as a producer that advances a global watermark,
and each question is scored the moment the watermark passes its timestamp, retrieving
bi-temporally as-of that instant. It scores each category on deterministic retrieval
recall@15 and LLM-judged QA accuracy. Runs are logged locally with
`pnpm bench:memory … --log`, which appends to `history.jsonl` and regenerates this
file plus the snapshot in the root `README.md`. See the `aura-memory-bench` skill.

## Current

Latest logged run: `65b1205` · 2026-05-31 17:47 UTC

- scope: `locomo/medium` · corpus `f9cf2279e3e1` · cases `a6f1cceb887cfe19` · runtime 75m04s · cost $10.88
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- MEMv3 flags: `MEMV3_PREFILTER=1` `MEMV3_ABSTENTION=0` `MEMV3_LASTMSG_WEIGHT=1` `MEMV3_SCORE_FUSION=1` `MEMV3_QUERY_REWRITE=1`
- overall: QA 14% · recall@15 55% (n=150)

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| locomo | adversarial | 7% | 40% | 30 |
| locomo | multi_hop | 22% | 51% | 30 |
| locomo | open_domain | 18% | 57% | 30 |
| locomo | single_hop | 10% | 67% | 30 |
| locomo | temporal | 12% | 59% | 30 |

## Evolution

Overall QA accuracy and recall@15 across logged runs (newest first).

| date | commit | scope | QA | recall@15 | n | cost | runtime |
|---|---|---|---:|---:|---:|---:|---:|
| 2026-05-31 | `65b1205` | locomo/medium | 14% | 55% | 150 | $10.88 | 75m04s |
| 2026-05-31 | `3643897` | locomo/medium | 20% | 69% | 150 | $10.92 | 76m37s |
| 2026-05-31 | `8099713-dirty` | locomo/medium | 28% | 78% | 150 | $11.04 | 74m41s |
| 2026-05-31 | `8099713-dirty` | longmemeval/medium | 55% | 88% | 180 | $12.03 | 80m31s |
| 2026-05-30 | `84515ad` | longmemeval/medium | 53% | 85% | 180 | $12.39 | 76m13s |
| 2026-05-30 | `0ee6037` | locomo+longmemeval/medium | 30% | 74% | 330 | $7.69 | 56m31s |
| 2026-05-29 | `c80b07e-dirty` | locomo+longmemeval/medium | 32% | 74% | 329 | $10.77 | 59m08s |
| 2026-05-28 | `0fd7f3b-dirty` | toy/medium | 100% | 100% | 5 | — | 1m32s |
