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

Latest baseline: `e0bb4c8` · 2026-06-01 10:12 UTC. One block per dataset.

### `longmemeval/medium`

- scope: `longmemeval/medium` · corpus `b178d604c01a` · cases `a0018f6e9f0fccb4` · runtime 75m19s · cost $12.28
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- overall: QA 54% · recall@15 86% (n=180)
- note: parallel per-dataset baseline on main e0bb4c8 after #1067+#1070

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| longmemeval | knowledge-update | 67% | 85% | 30 |
| longmemeval | multi-session | 68% | 88% | 30 |
| longmemeval | single-session-assistant | 27% | 83% | 30 |
| longmemeval | single-session-preference | 38% | 90% | 30 |
| longmemeval | single-session-user | 87% | 90% | 30 |
| longmemeval | temporal-reasoning | 40% | 82% | 30 |

### `locomo/medium`

- scope: `locomo/medium` · corpus `f9cf2279e3e1` · cases `a6f1cceb887cfe19` · runtime 79m37s · cost $11.30
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- overall: QA 22% · recall@15 76% (n=150)
- note: parallel per-dataset baseline on main e0bb4c8 after #1067+#1070

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| locomo | adversarial | 7% | 67% | 30 |
| locomo | multi_hop | 43% | 81% | 30 |
| locomo | open_domain | 30% | 83% | 30 |
| locomo | single_hop | 12% | 83% | 30 |
| locomo | temporal | 17% | 65% | 30 |

## Evolution

Overall QA accuracy and recall@15 over time, grouped by scope so every row in a table is comparable. Newest first.

### `locomo/toy`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `03d4a4c` | 40% | 92% | 10 | $3.38 | 58m53s |
| 2026-06-01 | `c34c107` | 40% | 81% | 10 | $3.35 | 41m38s |

### `toy/toy`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `d7504bf` | 100% | 100% | 5 | $0.09 | 1m01s |

### `longmemeval/toy`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `03d4a4c` | 67% | 79% | 12 | $0.57 | 2m57s |
| 2026-06-01 | `8435b97` | 71% | 79% | 12 | $0.57 | 3m03s |
| 2026-06-01 | `c34c107` | 67% | 71% | 12 | $0.57 | 3m09s |

### `locomo/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `e0bb4c8` | 22% | 76% | 150 | $11.30 | 79m37s |
| 2026-05-31 | `8099713-dirty` | 28% | 78% | 150 | $11.04 | 74m41s |

### `longmemeval/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-06-01 | `e0bb4c8` | 54% | 86% | 180 | $12.28 | 75m19s |
| 2026-05-31 | `8099713-dirty` | 55% | 88% | 180 | $12.03 | 80m31s |
| 2026-05-30 | `84515ad` | 53% | 85% | 180 | $12.39 | 76m13s |

### `locomo+longmemeval/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-05-30 | `0ee6037` | 30% | 74% | 330 | $7.69 | 56m31s |
| 2026-05-29 | `c80b07e-dirty` | 32% | 74% | 329 | $10.77 | 59m08s |

### `toy/medium`

| date | commit | QA | recall@15 | n | cost | runtime |
|---|---|---:|---:|---:|---:|---:|
| 2026-05-28 | `0fd7f3b-dirty` | 100% | 100% | 5 | — | 1m32s |
