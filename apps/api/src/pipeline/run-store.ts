/**
 * Server-owned resumable chat-run store.
 *
 * A "run" is one assistant turn. The server consumes the model's UI-message
 * stream to completion and persists every chunk, indexed by `(runId, seq)`,
 * regardless of whether any client is currently reading. Clients attach as
 * pure readers — they replay persisted chunks from a cursor and then tail live
 * output until the run reaches a terminal state.
 *
 * This mirrors the Vercel WDK resumable-streams contract (a run id + replay by
 * index) using the existing Postgres + Vercel stack, so:
 *   - a tab close / refresh / device hop never cancels generation (R1, R3, T2, T3, T5)
 *   - thread↔run identity is server-anchored (R4)
 *   - N runs can stream concurrently (R5)
 *   - explicit "stop" is the only thing that cancels a run server-side (T5)
 *
 * The pure persist/replay logic is decoupled from Drizzle via {@link RunStore}
 * so it can be unit-tested without a database.
 */

import type { UIMessageChunk } from "ai";

export type ChatRunStatus = "running" | "done" | "error" | "canceled";

export const TERMINAL_STATUSES: ReadonlySet<ChatRunStatus> = new Set<ChatRunStatus>([
  "done",
  "error",
  "canceled",
]);

export function isTerminal(status: ChatRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface ChatRunRecord {
  id: string;
  threadId: string;
  userId: string | null;
  modelId: string | null;
  status: ChatRunStatus;
  inputMessages: unknown;
  error: string | null;
}

export interface StoredChunk {
  seq: number;
  chunk: UIMessageChunk;
}

/**
 * Minimal persistence surface the persist/replay logic depends on. Implemented
 * by {@link dbRunStore} (Drizzle) in production and by an in-memory fake in tests.
 */
export interface RunStore {
  createRun(input: {
    threadId: string;
    userId?: string | null;
    modelId?: string | null;
    inputMessages?: unknown;
  }): Promise<string>;
  appendChunk(runId: string, seq: number, chunk: UIMessageChunk): Promise<void>;
  /** Chunks with `seq >= fromSeq`, ordered ascending. */
  getChunks(runId: string, fromSeq: number): Promise<StoredChunk[]>;
  /** Largest persisted `seq + 1` (i.e. where the next chunk will land). */
  getTailIndex(runId: string): Promise<number>;
  getRun(runId: string): Promise<ChatRunRecord | null>;
  /** Liveness heartbeat — bumps the run's `updatedAt` while the writer is alive. */
  touchRun(runId: string): Promise<void>;
  /** Set status only if the run is still `running` (so terminal states stick). */
  finishRun(runId: string, status: ChatRunStatus, error?: string | null): Promise<void>;
  /** Request cancellation; no-op if already terminal. */
  requestCancel(runId: string): Promise<void>;
  /** The newest non-terminal run for a thread, if any. */
  getActiveRunForThread(threadId: string): Promise<ChatRunRecord | null>;
  /** Map threadId → true when that thread has a currently-running run. */
  getGeneratingThreads(threadIds: string[]): Promise<Set<string>>;
}

const DEFAULT_POLL_MS = 400;
const DEFAULT_CANCEL_POLL_MS = 1000;
const DEFAULT_HEARTBEAT_MS = 5000;

/**
 * A run is "alive" only if its writer has heartbeat recently. We key liveness
 * off the heartbeat (not chunk cadence) so a legitimately long, quiet step
 * (e.g. a 75s tool call) is NOT mistaken for a dead writer. If the serverless
 * instance running the writer is hard-killed, the heartbeat stops and the run
 * goes stale, so it no longer shows a spinner or accepts resume attempts.
 */
export const RUN_STALE_MS = 30_000;

export function isRunStale(
  updatedAt: Date | string | number,
  now: number = Date.now(),
  thresholdMs: number = RUN_STALE_MS,
): boolean {
  const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts > thresholdMs;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Consume a model UI-message stream to completion, persisting each chunk under
 * an incrementing `seq`. This is the sole writer for a run and is meant to run
 * inside `waitUntil` so it survives client disconnects.
 *
 * Cancellation is durable: a separate poll watches the run's status and aborts
 * the supplied controller when the run is marked `canceled` (e.g. by an
 * explicit "stop" from any tab/device), so generation actually stops.
 */
export async function consumeAndPersist(
  store: RunStore,
  runId: string,
  uiStream: ReadableStream<UIMessageChunk>,
  options: {
    abortController?: AbortController;
    cancelPollMs?: number;
    heartbeatMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const { abortController, onError } = options;
  const cancelPollMs = options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  let canceled = false;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  if (abortController) {
    cancelPoll = setInterval(() => {
      void store
        .getRun(runId)
        .then((run) => {
          if (run && run.status === "canceled") {
            canceled = true;
            abortController.abort();
          }
        })
        .catch(() => {});
    }, cancelPollMs);
  }

  // Liveness heartbeat: while this writer is alive, keep the run "fresh" so a
  // hard-killed instance becomes detectable (see isRunStale).
  const heartbeat = setInterval(() => {
    void store.touchRun(runId).catch(() => {});
  }, heartbeatMs);

  const reader = uiStream.getReader();
  let seq = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await store.appendChunk(runId, seq, value);
      seq += 1;
    }
    await store.finishRun(runId, "done");
  } catch (error) {
    onError?.(error);
    if (canceled || abortController?.signal.aborted) {
      await store.finishRun(runId, "canceled").catch(() => {});
    } else {
      await store
        .finishRun(runId, "error", error instanceof Error ? error.message : String(error))
        .catch(() => {});
    }
  } finally {
    if (cancelPoll) clearInterval(cancelPoll);
    clearInterval(heartbeat);
    reader.releaseLock();
  }
}

/**
 * Build a readable UI-message stream for a run that (1) replays persisted
 * chunks from `startIndex`, then (2) tails newly-persisted chunks until the run
 * is terminal. Aborting `signal` only detaches this reader — it never affects
 * the run itself (the disconnect footgun guard).
 */
export function createReplayStream(
  store: RunStore,
  runId: string,
  options: {
    startIndex?: number;
    pollMs?: number;
    signal?: AbortSignal;
  } = {},
): ReadableStream<UIMessageChunk> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const signal = options.signal;
  let nextSeq = Math.max(0, options.startIndex ?? 0);

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        for (;;) {
          if (signal?.aborted) {
            controller.close();
            return;
          }

          const rows = await store.getChunks(runId, nextSeq);
          for (const row of rows) {
            controller.enqueue(row.chunk);
            nextSeq = row.seq + 1;
          }

          const run = await store.getRun(runId);
          if (!run) {
            // Unknown run: emit a terminating error chunk so the client doesn't hang.
            controller.enqueue({ type: "error", errorText: "Run not found" } as UIMessageChunk);
            controller.close();
            return;
          }

          if (isTerminal(run.status)) {
            // The writer appends all chunks before flipping to a terminal status,
            // so once terminal there is nothing left to miss after a final read.
            const tail = await store.getChunks(runId, nextSeq);
            for (const row of tail) {
              controller.enqueue(row.chunk);
              nextSeq = row.seq + 1;
            }
            controller.close();
            return;
          }

          if (rows.length === 0) {
            await sleep(pollMs, signal);
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
