/**
 * Regenerate the memory bench markdown views from the committed history.
 *
 * Reads `apps/api/bench/history.jsonl` and rewrites:
 *   - `apps/api/bench/latest.json`  (canonical latest state)
 *   - `apps/api/bench/README.md`  (detailed: current scores + evolution)
 *   - root `README.md`            (the snapshot block between markers)
 *
 * No DB, no LLM, no env needed — it only reads the history file. Handy after a
 * rebase, a manual history edit, or when adding the snapshot markers for the
 * first time.
 *
 * Usage:
 *   pnpm bench:report
 *   pnpm --filter aura-api bench:report
 */

import { readHistory, renderReports } from "../src/results-log.js";

const history = readHistory();
const { latestJson, benchReadme, mainReadme } = renderReports(history);

console.log(`Regenerated ${latestJson} from ${history.length} run(s).`);
console.log(`Regenerated ${benchReadme} from ${history.length} run(s).`);
if (mainReadme) {
  console.log(`Regenerated snapshot in ${mainReadme}.`);
} else {
  console.log(
    "Skipped root README snapshot — no BENCH_SNAPSHOT markers found (add them first).",
  );
}
