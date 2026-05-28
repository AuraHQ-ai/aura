# Memory bench results log

Each entry below is a **fingerprint** of one benchmark run: the commit it ran
against, the corpus hash, the config, and the per-category scores. Treat it as a
watermark — when a memory change lands you can look back and see exactly which
commit produced which numbers.

Append an entry with `pnpm bench:memory … --log` (add `--note="…"` for
context). Newest entries are at the top. A `-dirty` suffix on the commit means
the run included uncommitted changes, so the SHA alone won't reproduce it.

<!-- BENCH_LOG_ENTRIES (newest first) -->

## 2026-05-28 22:15 UTC · `0fd7f3b-dirty` · toy/medium

- runId `2026-05-28T22-13-39-068Z-8zxr4q8c` · corpus `65d4db8bbcbb` · runtime 1m32s
- note: fix ingest dedup collision (toy S1/S2 reuse) — temporal & knowledge_update QA 0%→100%

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| toy | abstention | 100% | — | 1 |
| toy | knowledge_update | 100% | 100% | 1 |
| toy | multi_hop | 100% | 100% | 1 |
| toy | single_hop | 100% | 100% | 1 |
| toy | temporal | 100% | 100% | 1 |

