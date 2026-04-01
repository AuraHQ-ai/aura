/**
 * Lightweight progress tracker for backfill scripts.
 * Prints elapsed time, % complete, and ETA (recalculated at each tick).
 */

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hrs = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hrs}h ${remainMin}m ${sec}s`;
}

export interface ProgressTracker {
  /** Increment completed count (default +1) and maybe print a status line. */
  tick: (n?: number) => void;
  /** Force-print current progress regardless of throttle. */
  print: () => void;
  /** Print final summary line. */
  done: () => void;
  /** Current completed count. */
  readonly completed: number;
  /** Total items. */
  readonly total: number;
}

export function createProgress(
  total: number,
  opts?: { label?: string; logEvery?: number },
): ProgressTracker {
  const label = opts?.label ?? "items";
  const logEvery = opts?.logEvery ?? 1;
  const startTime = Date.now();
  let completed = 0;
  let lastLogAt = 0;

  function formatLine(): string {
    const elapsed = Date.now() - startTime;
    const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : "0.0";
    let eta = "—";
    if (completed > 0 && completed < total) {
      const msPerItem = elapsed / completed;
      const remaining = (total - completed) * msPerItem;
      eta = formatDuration(remaining);
    } else if (completed >= total) {
      eta = "done";
    }
    return (
      `[${completed}/${total}] ${pct}% | ` +
      `elapsed ${formatDuration(elapsed)} | ETA ${eta}`
    );
  }

  function print() {
    console.log(`  ${label}: ${formatLine()}`);
  }

  function tick(n = 1) {
    completed += n;
    if (completed - lastLogAt >= logEvery || completed >= total) {
      print();
      lastLogAt = completed;
    }
  }

  function done() {
    const elapsed = Date.now() - startTime;
    console.log(
      `  ${label}: ${completed}/${total} done in ${formatDuration(elapsed)}`,
    );
  }

  return {
    tick,
    print,
    done,
    get completed() {
      return completed;
    },
    get total() {
      return total;
    },
  };
}
