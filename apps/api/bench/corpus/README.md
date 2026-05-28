# Memory benchmark corpus

This directory contains the corpus files consumed by `pnpm bench:memory`.

## Included now

- `longmemeval-subset.json` is a small normalized smoke subset shaped after the
  LongMemEval oracle format. LongMemEval is MIT-licensed:
  <https://github.com/xiaowu0162/LongMemEval>.
- `manifest.json` records the included datasets. The harness computes the
  effective SHA-256 corpus hash at runtime from included files.

The committed subset is intentionally small so the harness, database isolation,
scoring, persistence, cron, and PR workflow can be exercised cheaply. Replace or
extend this file with the deterministic ~100-question LongMemEval oracle subset
when refreshing benchmark coverage.

## Pending

LoCoMo is not vendored because its dataset is CC-BY-NC-4.0. Keep
`included: false` until the license decision is made for this commercial repo.
When approved, add `locomo-subset.json`, set `included: true`, and ensure cases
populate `evidenceDiaIds` for retrieval recall@15.

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
