# Memory bench results

<!-- Generated from history.jsonl by `pnpm bench:memory … --log` / `pnpm bench:report`. Do not edit by hand. -->

The memory bench replays vendored LoCoMo + LongMemEval corpora through Aura's real
`extract → retrieve → answer` pipeline and scores each category on deterministic
retrieval recall@15 and LLM-judged QA accuracy. Runs are logged locally with
`pnpm bench:memory … --log`, which appends to `history.jsonl` and regenerates this
file plus the snapshot in the root `README.md`. See the `aura-memory-bench` skill.

## Current

Latest logged run: `5c5b88a` · 2026-05-30 07:22 UTC

- scope: `locomo+longmemeval/medium` · corpus `950b9182adf7` · cases `b72a76c101efe60f` · runtime 9m12s · cost $0.83
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.8` · judge `anthropic/claude-opus-4.6`
- overall: QA 36% · recall@15 77% (n=22)

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| locomo | adversarial | 0% | 50% | 2 |
| locomo | multi_hop | 25% | 88% | 2 |
| locomo | open_domain | 50% | 100% | 2 |
| locomo | single_hop | 0% | 100% | 2 |
| locomo | temporal | 0% | 100% | 2 |
| longmemeval | knowledge-update | 100% | 75% | 2 |
| longmemeval | multi-session | 75% | 50% | 2 |
| longmemeval | single-session-assistant | 0% | 50% | 2 |
| longmemeval | single-session-preference | 50% | 50% | 2 |
| longmemeval | single-session-user | 50% | 100% | 2 |
| longmemeval | temporal-reasoning | 50% | 100% | 2 |

## Evolution

Overall QA accuracy and recall@15 across logged runs (newest first).

| date | commit | scope | QA | recall@15 | n | cost | runtime |
|---|---|---|---:|---:|---:|---:|---:|
| 2026-05-30 | `5c5b88a` | locomo+longmemeval/medium | 36% | 77% | 22 | $0.83 | 9m12s |
| 2026-05-29 | `c80b07e-dirty` | locomo+longmemeval/medium | 32% | 74% | 329 | $10.77 | 59m08s |
| 2026-05-28 | `0fd7f3b-dirty` | toy/medium | 100% | 100% | 5 | — | 1m32s |
