# Memory benchmark corpus

Small committed files only. Full benchmark data is **downloaded on demand** into `cache/` (gitignored).

## Committed

| File | Purpose |
|------|---------|
| `toy.json` | 3-case smoke test (`--dataset=toy`) |
| `manifest.json` | Dataset URLs and cache paths |

## On demand (not in git)

| File | How |
|------|-----|
| `cache/longmemeval_oracle.json` | `pnpm bench:fetch-corpus` (Hugging Face) |
| `cache/locomo10.json` | `pnpm bench:fetch-corpus` (snap-research/locomo) |
| `cache/longmemeval-subset.json` | Optional: `build-longmemeval-subset.mjs` for fixed 100-Q slice |

Subset tiers (`fast` / `medium` / `full`) are applied at runtime via stratified sampling in `fixtures.ts`.

## Refresh optional fixed subset

```bash
node apps/api/src/bench/scripts/build-longmemeval-subset.mjs apps/api/src/bench/corpus/cache/longmemeval_oracle.json
```

## Licenses

- **LongMemEval**: MIT ([repo](https://github.com/xiaowu0162/LongMemEval))
- **LoCoMo**: CC-BY-NC 4.0 — OK to use; keep out of git, download in CI cache
