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

Latest logged run: `c34c107` · 2026-06-01 10:53 UTC

- scope: `longmemeval/toy` · corpus `b178d604c01a` · cases `0785d34e2111c176` · runtime 3m09s · cost $0.57
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- overall: QA 67% · recall@15 71% (n=12)

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| longmemeval | knowledge-update | 100% | 75% | 2 |
| longmemeval | multi-session | 75% | 50% | 2 |
| longmemeval | single-session-assistant | 0% | 0% | 2 |
| longmemeval | single-session-preference | 75% | 100% | 2 |
| longmemeval | single-session-user | 100% | 100% | 2 |
| longmemeval | temporal-reasoning | 50% | 100% | 2 |

## Evolution

Overall QA accuracy and recall@15 across logged runs (newest first).

| date | commit | scope | QA | recall@15 | n | cost | runtime |
|---|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `c34c107` | longmemeval/toy | 67% | 71% | 12 | $0.57 | 3m09s |
| 2026-05-31 | `8099713-dirty` | locomo/medium | 28% | 78% | 150 | $11.04 | 74m41s |
| 2026-05-31 | `8099713-dirty` | longmemeval/medium | 55% | 88% | 180 | $12.03 | 80m31s |
| 2026-05-30 | `84515ad` | longmemeval/medium | 53% | 85% | 180 | $12.39 | 76m13s |
| 2026-05-30 | `0ee6037` | locomo+longmemeval/medium | 30% | 74% | 330 | $7.69 | 56m31s |
| 2026-05-29 | `c80b07e-dirty` | locomo+longmemeval/medium | 32% | 74% | 329 | $10.77 | 59m08s |
| 2026-05-28 | `0fd7f3b-dirty` | toy/medium | 100% | 100% | 5 | — | 1m32s |
