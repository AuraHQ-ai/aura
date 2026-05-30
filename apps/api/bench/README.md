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

Latest logged run: `0ee6037` · 2026-05-30 08:37 UTC

- scope: `locomo+longmemeval/medium` · corpus `950b9182adf7` · cases `3cfdf02bf0f8f9b0` · runtime 56m31s · cost $7.69
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- overall: QA 30% · recall@15 74% (n=330)

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| locomo | adversarial | 7% | 70% | 30 |
| locomo | multi_hop | 27% | 74% | 30 |
| locomo | open_domain | 17% | 77% | 30 |
| locomo | single_hop | 12% | 87% | 30 |
| locomo | temporal | 20% | 59% | 30 |
| longmemeval | knowledge-update | 67% | 80% | 30 |
| longmemeval | multi-session | 43% | 70% | 30 |
| longmemeval | single-session-assistant | 17% | 67% | 30 |
| longmemeval | single-session-preference | 28% | 73% | 30 |
| longmemeval | single-session-user | 68% | 87% | 30 |
| longmemeval | temporal-reasoning | 20% | 72% | 30 |

## Evolution

Overall QA accuracy and recall@15 across logged runs (newest first).

| date | commit | scope | QA | recall@15 | n | cost | runtime |
|---|---|---|---:|---:|---:|---:|---:|
| 2026-05-30 | `0ee6037` | locomo+longmemeval/medium | 30% | 74% | 330 | $7.69 | 56m31s |
| 2026-05-29 | `c80b07e-dirty` | locomo+longmemeval/medium | 32% | 74% | 329 | $10.77 | 59m08s |
| 2026-05-28 | `0fd7f3b-dirty` | toy/medium | 100% | 100% | 5 | — | 1m32s |
