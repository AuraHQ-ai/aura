# Memory bench corpora

Falsifiable scoring depends on the corpus being honest, reproducible, and not bloating the repo. This directory holds **only** the manifest and a tiny vendored fixture; the real corpora are fetched on demand into a gitignored cache.

## Layout

```
corpus/
  manifest.json              # checked in — source of truth
  README.md                  # this file
  toy.json                   # checked in — 3-question smoke fixture
  cache/                     # GITIGNORED — populated by bench:fetch-corpus
    longmemeval_oracle.json  # ~50 MB once fetched
    locomo10_rag.json        # ~12 MB once fetched
```

## Fetching the real corpora

```bash
pnpm bench:fetch-corpus              # idempotent; skips files already cached
pnpm bench:fetch-corpus -- --force   # redownload everything
```

The script reads `manifest.json`, downloads each non-vendored entry to its target path, and prints a sha256 of every file. Re-running with the cache populated is a no-op (it just reprints the hashes).

In CI the `apps/api/bench/corpus/cache/` directory is cached by `actions/cache@v4` keyed on `manifest.json`, so subsequent runs don't hit the network.

## What's actually pinned

| Dataset | Source | Vendored? | Questions |
|---|---|---|---|
| `toy` | hand-written | always | 3 |
| `longmemeval` | [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) (MIT) | fetched | 500 |
| `locomo` | [snap-research/locomo](https://github.com/snap-research/locomo) | fetched | 1,540 |

Both projects are public research releases. The harness records the sha256 of every loaded file in `bench_runs.corpus_hash`, so deltas are honest: if a corpus changes upstream the chart will not silently lie — different hash, different baseline.

## Why not vendor the JSON?

LongMemEval is ~50 MB and LoCoMo is ~12 MB. Committing them bloats clones for everyone, slows CI, and noises up diffs whenever upstream republishes. The fetch-and-cache pattern keeps the repo small and the bench reproducible.

## Adding a new corpus

1. Pick a public, stable URL.
2. Add a `datasets` entry to `manifest.json` with `vendored: false` and a `fetchUrl`.
3. Write a loader in `bench/src/fixtures.ts` that returns `BenchCase[]`.
4. Update this README.
