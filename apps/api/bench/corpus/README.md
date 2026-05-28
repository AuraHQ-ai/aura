# Memory bench corpora

Falsifiable scoring depends on the corpus being honest and reproducible. This directory holds the inputs the harness replays through Aura's real extract → retrieve → answer pipeline.

## What ships in this folder

| File | License | Vendored? | Used for |
|---|---|---|---|
| `toy.json` | internal | always | smoke-test, CI sanity check, `--dataset=toy` |
| `longmemeval-subset.json` | MIT | when fetched | `--dataset=lme` (temporal, knowledge-update, abstention) |
| `locomo-subset.json` | CC-BY-NC-4.0 | **pending legal check** | `--dataset=locomo` (single_hop, multi_hop, temporal, open_domain, adversarial) |
| `manifest.json` | — | always | source-of-truth metadata + corpus hash |

The runner reads `manifest.json` to discover which files exist on disk. Missing files are skipped with a warning, so the bench still produces a partial score when only `toy.json` is present.

## LongMemEval — MIT (safe to vendor)

Source: <https://github.com/xiaowu0162/LongMemEval>. The MIT license permits vendoring with attribution. We pin a stratified 100-question subset from `longmemeval_oracle.json` (the oracle variant ships only the evidence sessions, which is the cheapest replay).

To refresh:

```bash
pnpm --filter aura-api tsx bench/scripts/fetch-longmemeval.ts \
  --out apps/api/bench/corpus/longmemeval-subset.json \
  --seed 4711
```

The script is hermetic — deterministic for a given seed. The first vendored copy was generated with `seed=4711`.

## LoCoMo — CC-BY-NC-4.0 (decision required)

Source: <https://github.com/snap-research/locomo>. The license is non-commercial. Vendoring it into a commercial repo needs an explicit decision; see "Open questions" in #1043.

Until then, the harness:

1. **Does not** include `locomo-subset.json` in the repo.
2. Logs a `Skipping dataset=locomo: file missing` warning and continues.
3. Scores everything that *is* present.

If you have a local copy (e.g. for ad-hoc evaluation), drop it at `apps/api/bench/corpus/locomo-subset.json` and run with `--dataset=locomo`. Do **not** commit the file.

## Manifest hashing

`manifest.json` is read at run start. The harness hashes every file it actually loads and stores the SHA-256 alongside the run in `bench_runs.corpus_hash`. This means delta plots are safe: if you change the corpus mid-quarter the chart will not silently lie — different hash, different baseline.

## Adding a new corpus

1. Pick an MIT/Apache-licensed source (or get clearance for CC-BY-NC, see above).
2. Add a loader to `bench/src/fixtures.ts` that returns `BenchCase[]`.
3. Append an entry to `manifest.json`.
4. Update this README.
