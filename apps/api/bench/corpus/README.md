# Memory benchmark corpus

This directory contains the corpus files consumed by `pnpm bench:memory`.

## Included now

- `longmemeval-subset.json` is a small normalized smoke subset shaped after the
  LongMemEval oracle format. LongMemEval is MIT-licensed:
  <https://github.com/xiaowu0162/LongMemEval>.
- `manifest.json` records the included datasets. The harness computes the
  effective SHA-256 corpus hash at runtime from included files.

The committed subset is intentionally small so the harness, database isolation,
scoring, persistence, and PR workflow can be exercised cheaply without polluting
the repo with large benchmark data files.

## Full/review-grade corpora

LoCoMo can be used for Aura, but do not vendor the full dataset or many derived
files into this repo. Keep larger normalized subsets outside git and pass them
explicitly:

```bash
pnpm --filter aura-api bench:memory -- \
  --dataset=both \
  --subset=full \
  --corpus-file=/path/to/normalized-memory-bench.json
```

The external file should contain enough conversations to be meaningful for
temporal and multi-session categories. LoCoMo cases should populate
`evidenceDiaIds` for deterministic retrieval recall@15.

## Normalized case shape

Each JSON file is an array of:

```ts
{
  id: string;
  source: "locomo" | "longmemeval";
  category: string;
  question: string;
  goldAnswer: string | string[];
  abstention: boolean;
  sessions: Array<{
    id: string;
    timestamp: string;
    turns: Array<{ role: "user" | "assistant"; content: string; diaId?: string }>;
  }>;
  evidenceSessionIds?: string[];
  evidenceDiaIds?: string[];
}
```
