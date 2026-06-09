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

Latest baseline: `c94fcae` · 2026-06-04 17:06 UTC.

### `longmemeval/medium`

- scope: `longmemeval/medium` · corpus `b178d604c01a` · cases `a0018f6e9f0fccb4` · runtime 108m32s · cost $20.27
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- overall: QA 74% · recall@15 92% (n=180)

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| longmemeval | knowledge-update | 77% | 95% | 30 |
| longmemeval | multi-session | 60% | 93% | 30 |
| longmemeval | single-session-assistant | 83% | 90% | 30 |
| longmemeval | single-session-preference | 50% | 93% | 30 |
| longmemeval | single-session-user | 100% | 93% | 30 |
| longmemeval | temporal-reasoning | 77% | 85% | 30 |

## Evolution

Overall QA accuracy and recall@15 over time, grouped by scope so every row in a table is comparable. Newest first.

### `longmemeval/toy`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-09 | `4a59757` | 83% | 88% | 12 | $1.00 | 12m54s |
| 2026-06-09 | `eef4a15` | 75% | 88% | 12 | $0.99 | 13m43s |
| 2026-06-08 | `c50ebb0` | 83% | 83% | 12 | $0.96 | 11m46s |
| 2026-06-03 | `0e3fb13` | 79% | 88% | 12 | $1.00 | 13m58s |
| 2026-06-03 | `26a54c6` | 71% | 92% | 12 | $0.96 | 10m48s |
| 2026-06-02 | `ad3d3da` | 75% | 92% | 12 | $1.01 | 14m47s |
| 2026-06-01 | `59ef24f` | 58% | 88% | 12 | $0.58 | 6m45s |
| 2026-06-01 | `e6d0e17` | 67% | 79% | 12 | $0.58 | 3m45s |
| 2026-06-01 | `03d4a4c` | 67% | 79% | 12 | $0.57 | 2m57s |
| 2026-06-01 | `8435b97` | 71% | 79% | 12 | $0.57 | 3m03s |
| 2026-06-01 | `c34c107` | 67% | 71% | 12 | $0.57 | 3m09s |

### `locomo/full`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-04 | `d284163` | 44% | 81% | 1983 | $37.92 | 74m29s |
| 2026-06-03 | `57c088c` | 45% | 80% | 1986 | $36.69 | 62m38s |
| 2026-06-02 | `deb43d8` | 37% | 70% | 1986 | $70.26 | 105m30s |

### `longmemeval/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-04 | `c94fcae` | 74% | 92% | 180 | $20.27 | 108m32s |
| 2026-06-02 | `f877bc5` | 72% | 92% | 180 | $20.61 | 153m51s |
| 2026-06-02 | `e16d3d0` | 66% | 93% | 180 | $20.57 | 144m55s |
| 2026-06-02 | `772e8fb` | 65% | 93% | 179 | $21.71 | 138m27s |
| 2026-06-02 | `6452709` | 61% | 89% | 179 | $13.29 | 98m12s |
| 2026-06-01 | `0d311e5` | 59% | 89% | 180 | $13.05 | 99m10s |
| 2026-06-01 | `9cdfda1` | 60% | 90% | 180 | $12.32 | 104m15s |
| 2026-06-01 | `e0bb4c8` | 54% | 86% | 180 | $12.28 | 75m19s |
| 2026-05-31 | `8099713-dirty` | 55% | 88% | 180 | $12.03 | 80m31s |
| 2026-05-30 | `84515ad` | 53% | 85% | 180 | $12.39 | 76m13s |

### `locomo/toy`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `03d4a4c` | 40% | 92% | 10 | $3.38 | 58m53s |
| 2026-06-01 | `c34c107` | 40% | 81% | 10 | $3.35 | 41m38s |

### `toy/toy`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `d7504bf` | 100% | 100% | 5 | $0.09 | 1m01s |

### `locomo/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `e0bb4c8` | 22% | 76% | 150 | $11.30 | 79m37s |
| 2026-05-31 | `8099713-dirty` | 28% | 78% | 150 | $11.04 | 74m41s |

### `locomo+longmemeval/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-05-30 | `0ee6037` | 30% | 74% | 330 | $7.69 | 56m31s |
| 2026-05-29 | `c80b07e-dirty` | 32% | 74% | 329 | $10.77 | 59m08s |

### `toy/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-05-28 | `0fd7f3b-dirty` | 100% | 100% | 5 | — | 1m32s |
