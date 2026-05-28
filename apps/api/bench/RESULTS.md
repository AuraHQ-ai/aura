# Memory bench results log

Each entry below is a **fingerprint** of one benchmark run: the commit it ran
against, the corpus hash, the config, and the per-category scores. Treat it as a
watermark — when a memory change lands you can look back and see exactly which
commit produced which numbers.

Append an entry with `pnpm bench:memory … --log` (add `--note="…"` for
context). Newest entries are at the top. A `-dirty` suffix on the commit means
the run included uncommitted changes, so the SHA alone won't reproduce it.

<!-- BENCH_LOG_ENTRIES (newest first) -->
