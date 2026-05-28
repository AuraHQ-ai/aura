# Memory benchmark corpus

Vendored subsets for `pnpm bench:memory` (issue #1043). Runs use an isolated `bench-{runId}` workspace; production memories are never touched.

## Files

| File | License | Notes |
|------|---------|--------|
| `longmemeval-subset.json` | [MIT](https://github.com/xiaowu0162/LongMemEval) | 100 questions stratified from `longmemeval_oracle.json` (seed `1043`): temporal-reasoning, knowledge-update, multi-session |
| `toy-corpus.json` | Aura (internal) | 3 cases for fast local smoke tests (`--dataset=toy`) |
| `locomo-subset.json` | *Not vendored* | LoCoMo is CC-BY-NC 4.0 — confirm license before adding to this repo |
| `manifest.json` | — | `corpus_hash` for skip-ingest caching |

## Refresh LongMemEval subset

```bash
curl -sL -o /tmp/longmemeval_oracle.json \
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json'
node apps/api/src/bench/scripts/build-longmemeval-subset.mjs
```

## Normalized shape

See `apps/api/src/bench/types.ts` (`BenchCase`). Session `id` values are stored as `source_thread_ts` on extracted memories for retrieval recall@K.
