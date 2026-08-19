/**
 * Ink-based live dashboard for the memory bench.
 *
 * Renders the production-faithful timeline as concurrent tracks rather than
 * three sequential stages: the producer (extraction, advancing the global
 * watermark/frontier) and the consumer (scoring, scored/total) run at the same
 * time and their bars fill in parallel. A live scores line (QA% / recall%) and
 * a running cost meter sit below. Ink's `patchConsole` captures every
 * `console.*` write and prints it ABOVE the dashboard, so pipeline logs scroll
 * cleanly while the bars stay pinned to the bottom — replacing the old manual
 * ANSI live-region hack in the logger.
 *
 * The runner talks to a tiny external store (subscribe/getSnapshot wired into
 * React via `useSyncExternalStore`); a local interval re-renders ~8×/s so the
 * spinner spins and elapsed/ETA tick even when no progress event fires.
 *
 * This file is `.tsx` and pulls in `ink`/`react` (ESM-only, dev/CLI surface),
 * so it MUST only ever be loaded via dynamic `import()` from the TTY bench
 * path — never on the Vercel runtime.
 */
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { render, Box, Text } from "ink";
import Spinner from "ink-spinner";

export type StageStatus = "pending" | "active" | "done";

interface StageState {
  name: string;
  label: string;
  status: StageStatus;
  done: number;
  total: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface Scores {
  qaCorrect: number;
  qaTotal: number;
  recallHit: number;
  recallTotal: number;
}

interface Cost {
  usd: number;
  tokens: number;
}

interface Snapshot {
  stages: StageState[];
  scores: Scores | null;
  cost: Cost | null;
  startedAt: number;
}

interface StageDef {
  name: string;
  label: string;
}

class DashboardStore {
  private state: Snapshot;
  private listeners = new Set<() => void>();

  constructor(stageDefs: StageDef[]) {
    this.state = {
      stages: stageDefs.map((d) => ({
        name: d.name,
        label: d.label,
        status: "pending",
        done: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
      })),
      scores: null,
      cost: null,
      startedAt: Date.now(),
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.state;

  private commit(next: Snapshot): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  private mapStage(name: string, fn: (s: StageState) => StageState): void {
    this.commit({
      ...this.state,
      stages: this.state.stages.map((s) => (s.name === name ? fn(s) : s)),
    });
  }

  startStage(name: string, total: number): void {
    this.mapStage(name, (s) => ({
      ...s,
      status: "active",
      total,
      done: 0,
      startedAt: s.startedAt ?? Date.now(),
    }));
  }

  updateStage(name: string, done: number, total?: number): void {
    this.mapStage(name, (s) => ({
      ...s,
      status: s.status === "done" ? "done" : "active",
      done,
      total: total ?? s.total,
      startedAt: s.startedAt ?? Date.now(),
    }));
  }

  finishStage(name: string): void {
    this.mapStage(name, (s) => ({
      ...s,
      status: "done",
      done: s.total > 0 ? s.total : s.done,
      finishedAt: Date.now(),
    }));
  }

  setScores(scores: Scores): void {
    this.commit({ ...this.state, scores });
  }

  setCost(cost: Cost): void {
    this.commit({ ...this.state, cost });
  }
}

const BAR_WIDTH = 24;

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, "0")}s`;
}

function renderBar(done: number, total: number): string {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function StageRow({ stage, now }: { stage: StageState; now: number }): React.ReactElement {
  const { status, done, total, label, startedAt, finishedAt } = stage;
  const elapsed =
    startedAt == null ? 0 : (finishedAt ?? now) - startedAt;
  const eta =
    status === "active" && done > 0 && total > 0
      ? (elapsed / done) * (total - done)
      : null;

  const icon =
    status === "done" ? (
      <Text color="green">✓</Text>
    ) : status === "active" ? (
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    ) : (
      <Text color="gray">·</Text>
    );

  const barColor =
    status === "done" ? "green" : status === "active" ? "cyan" : "gray";

  return (
    <Box>
      <Box width={2}>{icon}</Box>
      <Box width={20}>
        <Text color={status === "pending" ? "gray" : "white"}>{label}</Text>
      </Box>
      <Text color={barColor}>{renderBar(done, total)}</Text>
      <Text> </Text>
      <Box width={11}>
        <Text color={status === "pending" ? "gray" : "white"}>
          {done}/{total || "?"}
        </Text>
      </Box>
      <Text color="gray">
        {status === "pending"
          ? ""
          : `${fmtDuration(elapsed)}${eta != null ? `  ETA ${fmtDuration(eta)}` : ""}`}
      </Text>
    </Box>
  );
}

function Dashboard({ store }: { store: DashboardStore }): React.ReactElement {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(t);
  }, []);

  const { scores, cost } = snap;
  const qaPct =
    scores && scores.qaTotal > 0
      ? ((scores.qaCorrect / scores.qaTotal) * 100).toFixed(0)
      : null;
  const recallPct =
    scores && scores.recallTotal > 0
      ? ((scores.recallHit / scores.recallTotal) * 100).toFixed(0)
      : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="gray">
          timeline · producer (extraction frontier) ‖ consumer (scoring) overlap
        </Text>
      </Box>
      {snap.stages.map((s) => (
        <StageRow key={s.name} stage={s} now={now} />
      ))}
      <Box marginTop={1}>
        <Text color="gray">scores </Text>
        <Text color="magenta">
          QA {qaPct != null ? `${qaPct}%` : "—"}
          {scores && scores.qaTotal > 0 ? ` (${scores.qaCorrect}/${scores.qaTotal})` : ""}
        </Text>
        <Text color="gray">  ·  </Text>
        <Text color="blue">
          recall {recallPct != null ? `${recallPct}%` : "—"}
          {scores && scores.recallTotal > 0
            ? ` (${scores.recallHit}/${scores.recallTotal})`
            : ""}
        </Text>
        <Text color="gray">  ·  </Text>
        <Text color="yellow">
          ${cost ? cost.usd.toFixed(4) : "0.0000"}
          {cost && cost.tokens > 0 ? ` (${(cost.tokens / 1000).toFixed(1)}k tok)` : ""}
        </Text>
      </Box>
    </Box>
  );
}

export interface StageHandle {
  start(total: number): void;
  update(done: number, total?: number): void;
  done(): void;
}

export interface Dashboard {
  stage(name: string): StageHandle;
  setScores(scores: Scores): void;
  setCost(cost: Cost): void;
  stop(): void;
}

/**
 * Mount the Ink dashboard for the given stages. Returns a small imperative
 * handle the runner drives from each stage's progress callbacks. `patchConsole`
 * is on so logger output (which writes via `console.*`) scrolls above the bars.
 */
export function createDashboard(stageDefs: StageDef[]): Dashboard {
  const store = new DashboardStore(stageDefs);
  const instance = render(<Dashboard store={store} />, {
    patchConsole: true,
    exitOnCtrlC: false,
  });

  return {
    stage(name: string): StageHandle {
      return {
        start: (total: number) => store.startStage(name, total),
        update: (done: number, total?: number) =>
          store.updateStage(name, done, total),
        done: () => store.finishStage(name),
      };
    },
    setScores: (scores: Scores) => store.setScores(scores),
    setCost: (cost: Cost) => store.setCost(cost),
    stop: () => {
      // One final synchronous render, then unmount so the last frame persists.
      instance.rerender(<Dashboard store={store} />);
      instance.unmount();
    },
  };
}
