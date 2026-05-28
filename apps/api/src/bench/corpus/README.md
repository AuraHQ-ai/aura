# Memory benchmark corpus

Small committed files only. Full benchmark data is **downloaded on demand** into `cache/` (gitignored).

## Committed

| File | Purpose |
|------|---------|
| `toy-corpus.json` | 3-case smoke test (`--dataset=toy`) |
| `manifest.json` | Subset seed, per-category counts, oracle URL |

## On demand (not in git)

| File | How |
|------|-----|
| `cache/longmemeval_oracle.json` | `curl` from Hugging Face (see manifest) |
| `cache/longmemeval-subset.json` | Built by `build-longmemeval-subset.mjs` (100 Q, seed 1043) |
| `cache/locomo-subset.json` | Future: build script when LoCoMo is wired up |

First `pnpm bench:memory -- --dataset=lme` downloads the oracle (~50MB) once, then builds the subset.

## Refresh subset

```bash
node apps/api/src/bench/scripts/build-longmemeval-subset.mjs apps/api/src/bench/corpus/cache/longmemeval_oracle.json
```

## Licenses

- **LongMemEval**: MIT ([repo](https://github.com/xiaowu0162/LongMemEval))
- **LoCoMo**: CC-BY-NC 4.0 — OK to use; keep out of git, download in CI cache
