/**
 * Non-TTY progress heartbeat for the bench harness.
 *
 * The interactive (TTY) path is owned by the Ink dashboard
 * ([dashboard.tsx](./dashboard.tsx)). This module is the fallback for CI /
 * piped output: it emits a periodic `logger.info` heartbeat with done/total,
 * elapsed and ETA so non-interactive logs still show forward progress.
 *
 *   const p = createProgress("extract", total);  // logs "started"
 *   p.update(done);   // call as work completes (drives the heartbeat counter)
 *   p.done();         // logs "complete"
 */

import { logger } from "../../src/lib/logger.js";

export interface Progress {
  update(done: number, total?: number): void;
  done(): void;
}

/** Heartbeat cadence for the non-TTY log fallback. */
const HEARTBEAT_MS = 15_000;

export function createProgress(label: string, total: number): Progress {
  const start = Date.now();
  let current = 0;
  let runningTotal = total;
  let finished = false;

  const logHeartbeat = (): void => {
    const clamped = Math.max(0, Math.min(current, runningTotal));
    const elapsed = Date.now() - start;
    const eta = clamped > 0 ? (elapsed / clamped) * (runningTotal - clamped) : 0;
    logger.info(`bench: ${label} ${clamped}/${runningTotal} running…`, {
      elapsedMs: elapsed,
      etaMs: Math.round(eta),
    });
  };

  logger.info(`bench: ${label} started`, { total });
  const timer = setInterval(logHeartbeat, HEARTBEAT_MS);
  timer?.unref?.();

  return {
    update: (done: number, t?: number) => {
      current = done;
      if (t != null) runningTotal = t;
    },
    done: () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      current = runningTotal;
      logger.info(`bench: ${label} complete`, {
        total: runningTotal,
        elapsedMs: Date.now() - start,
      });
    },
  };
}
