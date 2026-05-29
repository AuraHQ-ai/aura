# Memory bench results

<!-- Generated from history.jsonl by `pnpm bench:memory … --log` / `pnpm bench:report`. Do not edit by hand. -->

The memory bench replays vendored LoCoMo + LongMemEval corpora through Aura's real
`extract → retrieve → answer` pipeline and scores each category on deterministic
retrieval recall@15 and LLM-judged QA accuracy. Runs are logged locally with
`pnpm bench:memory … --log`, which appends to `history.jsonl` and regenerates this
file plus the snapshot in the root `README.md`. See the `aura-memory-bench` skill.

## Current

Latest logged run: `c80b07e-dirty` · 2026-05-29 12:01 UTC

- scope: `locomo+longmemeval/medium` · corpus `950b9182adf7` · runtime 59m08s · cost $10.77
- models: extraction `anthropic/claude-haiku-4.5` · answerer `anthropic/claude-opus-4.7` · judge `anthropic/claude-opus-4.6`
- overall: QA 32% · recall@15 74% (n=329)
- note: medium baseline on current codebase

| dataset     | category                  | QA acc | recall@15 |    n |
| ----------- | ------------------------- | -----: | --------: | ---: |
| locomo      | adversarial               |     3% |       87% |   30 |
| locomo      | multi_hop                 |    25% |       64% |   30 |
| locomo      | open_domain               |    55% |       80% |   30 |
| locomo      | single_hop                |    10% |       61% |   30 |
| locomo      | temporal                  |    13% |       68% |   30 |
| longmemeval | knowledge-update          |    65% |       78% |   30 |
| longmemeval | multi-session             |    22% |       68% |   30 |
| longmemeval | single-session-assistant  |    27% |       73% |   30 |
| longmemeval | single-session-preference |    38% |       70% |   30 |
| longmemeval | single-session-user       |    72% |       87% |   30 |
| longmemeval | temporal-reasoning        |    26% |       77% |   30 |

## Evolution

Overall QA accuracy and recall@15 across logged runs (newest first).

| date       | commit          | scope                     |   QA | recall@15 |    n |   cost | runtime |
| ---------- | --------------- | ------------------------- | ---: | --------: | ---: | -----: | ------: |
| 2026-05-29 | `c80b07e-dirty` | locomo+longmemeval/medium |  32% |       74% |  329 | $10.77 |  59m08s |
| 2026-05-28 | `0fd7f3b-dirty` | toy/medium                | 100% |      100% |    5 |      — |   1m32s |
