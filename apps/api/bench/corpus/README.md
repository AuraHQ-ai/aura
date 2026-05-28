# Memory benchmark corpus

This directory contains a tiny committed `toy.json` smoke fixture and a manifest
for fetching real benchmark data on demand.

Large LoCoMo / LongMemEval files are intentionally **not** committed. Fetch them
into the gitignored cache directory when you need a review-grade run:

```bash
pnpm --filter aura-api bench:fetch-corpus
pnpm --filter aura-api bench:memory -- --dataset=both --subset=medium
```

Use `--subset=full` for manual deep dives. The GitHub workflow defaults PR runs
to `medium` for memory-path changes and lets manual dispatch choose `full`.

## Data sources

- LongMemEval oracle: MIT, fetched from
  `xiaowu0162/longmemeval-cleaned`.
- LoCoMo: fetched from `snap-research/locomo`.

Both are normalized at load time into:

```ts
{
  id: string;
  source: "toy" | "locomo" | "longmemeval";
  category: string;
  question: string;
  goldAnswer: string | string[];
  abstention: boolean;
  sessions: Array<{
    id: string;
    timestamp: string;
    turns: Array<{
      role: "user" | "assistant";
      content: string;
      diaId?: string;
      speaker?: string;
    }>;
  }>;
  evidenceSessionIds?: string[];
  evidenceDiaIds?: string[];
}
```

You can also bypass the manifest/cache and pass a normalized external file:

```bash
pnpm --filter aura-api bench:memory -- \
  --dataset=both \
  --subset=full \
  --corpus-file=/path/to/normalized-memory-bench.json
```
