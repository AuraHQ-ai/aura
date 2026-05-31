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

Latest logged run: `9a86d8c` · 2026-05-31 21:33 UTC

- scope: `locomo/medium` · corpus `f9cf2279e3e1` · cases `a6f1cceb887cfe19` · runtime 2m03s · cost $1.16
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- MEMv3 flags: `MEMV3_PREFILTER=1` `MEMV3_ABSTENTION=0` `MEMV3_LASTMSG_WEIGHT=1` `MEMV3_SCORE_FUSION=1` `MEMV3_QUERY_REWRITE=1`
- overall: QA 1% · recall@15 0% (n=150)

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| locomo | adversarial | 7% | 0% | 30 |
| locomo | multi_hop | 0% | 0% | 30 |
| locomo | open_domain | 0% | 0% | 30 |
| locomo | single_hop | 0% | 0% | 30 |
| locomo | temporal | 0% | 0% | 30 |

## Evolution

Overall QA accuracy and recall@15 across logged runs (newest first).

| date | commit | scope | QA | recall@15 | n | cost | runtime |
|---|---|---|---:|---:|---:|---:|---:|
| 2026-05-31 | `9a86d8c` | locomo/medium | 1% | 0% | 150 | $1.16 | 2m03s |
| 2026-05-31 | `8099713-dirty` | locomo/medium | 28% | 78% | 150 | $11.04 | 74m41s |
| 2026-05-31 | `8099713-dirty` | longmemeval/medium | 55% | 88% | 180 | $12.03 | 80m31s |
| 2026-05-30 | `84515ad` | longmemeval/medium | 53% | 85% | 180 | $12.39 | 76m13s |
| 2026-05-30 | `0ee6037` | locomo+longmemeval/medium | 30% | 74% | 330 | $7.69 | 56m31s |
| 2026-05-29 | `c80b07e-dirty` | locomo+longmemeval/medium | 32% | 74% | 329 | $10.77 | 59m08s |
| 2026-05-28 | `0fd7f3b-dirty` | toy/medium | 100% | 100% | 5 | — | 1m32s |
