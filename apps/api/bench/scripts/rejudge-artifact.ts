/**
 * Re-grade a finished run's cases.jsonl with the CURRENT judge code, isolating
 * the judge change: same (question, gold, modelAnswer) triples, new verdicts.
 * No re-extraction / re-answering. Usage:
 *   pnpm exec tsx bench/scripts/rejudge-artifact.ts <cases.jsonl> [concurrency]
 */
import { readFileSync } from "node:fs";
import { judgeAnswer } from "../src/judge.js";
import type { BenchCase } from "../src/types.js";

function qa(v: string): number {
  return v === "correct" || v === "abstain_ok" ? 1 : v === "partial" ? 0.5 : 0;
}

async function main() {
  const path = process.argv[2];
  const concurrency = Number(process.argv[3] ?? 10);
  const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const out: { category: string; old: string; neu: string }[] = new Array(rows.length);

  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= rows.length) return;
      const c = rows[i];
      const benchCase = {
        id: c.caseId,
        source: c.dataset,
        category: c.category,
        question: c.question,
        goldAnswer: c.goldAnswer,
        abstention: c.abstention ?? false,
        sessions: [],
      } as unknown as BenchCase;
      try {
        const j = await judgeAnswer(benchCase, c.modelAnswer ?? "");
        out[i] = { category: c.category, old: c.judgeVerdict, neu: j.verdict };
      } catch (e) {
        out[i] = { category: c.category, old: c.judgeVerdict, neu: c.judgeVerdict };
      }
      if (i % 25 === 0) process.stderr.write(`  rejudged ${i}/${rows.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const cats = [...new Set(out.map((o) => o.category))].sort();
  let oS = 0, nS = 0, N = 0;
  console.log("category".padEnd(26), "old QA", "->", "new QA", "  Δ", "  flips");
  for (const cat of cats) {
    const cc = out.filter((o) => o.category === cat);
    const o = cc.reduce((s, x) => s + qa(x.old), 0) / cc.length;
    const n = cc.reduce((s, x) => s + qa(x.neu), 0) / cc.length;
    const flips = cc.filter((x) => qa(x.old) !== qa(x.neu)).length;
    console.log(
      cat.padEnd(26),
      (o * 100).toFixed(1).padStart(5) + "%", "->",
      (n * 100).toFixed(1).padStart(5) + "%",
      ((n - o >= 0 ? "+" : "") + ((n - o) * 100).toFixed(1)).padStart(6),
      ("   " + flips).padStart(6),
    );
    oS += o * cc.length; nS += n * cc.length; N += cc.length;
  }
  console.log(
    "OVERALL".padEnd(26),
    (oS / N * 100).toFixed(1).padStart(5) + "%", "->",
    (nS / N * 100).toFixed(1).padStart(5) + "%",
    ((nS - oS >= 0 ? "+" : "") + ((nS - oS) / N * 100).toFixed(1)).padStart(6),
  );
  process.exit(0);
}
main();
