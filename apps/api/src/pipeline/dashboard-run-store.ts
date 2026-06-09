import type { UIMessageChunk } from "ai";

export type DashboardRunStatus = "generating" | "completed" | "failed" | "cancelled";

const TERMINAL_STATUSES = new Set<DashboardRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalRunStatus(status: DashboardRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface DashboardRunRecord {
  id: string;
  threadId: string;
  userId: string;
  userName: string | null;
  messageId: string;
  prompt: string;
  inputMessages: unknown;
  modelId: string | null;
  status: DashboardRunStatus;
  error: string | null;
}

export interface StoredDashboardChunk {
  chunkIndex: number;
  chunk: UIMessageChunk;
}

export interface DashboardRunStore {
  createRun(input: {
    id?: string;
    threadId: string;
    userId: string;
    userName?: string | null;
    messageId: string;
    prompt: string;
    inputMessages?: unknown;
    modelId?: string | null;
  }): Promise<string>;
  updateModelId(runId: string, modelId: string): Promise<void>;
  appendChunk(runId: string, chunkIndex: number, chunk: UIMessageChunk): Promise<void>;
  getChunks(runId: string, fromIndex: number): Promise<StoredDashboardChunk[]>;
  /** Highest persisted chunk index, or -1 when no chunks exist yet. */
  getTailIndex(runId: string): Promise<number>;
  getRun(runId: string): Promise<DashboardRunRecord | null>;
  finishRun(runId: string, status: DashboardRunStatus, error?: string | null): Promise<void>;
  requestCancel(runId: string): Promise<void>;
  getActiveRunForThread(threadId: string): Promise<DashboardRunRecord | null>;
}

const DEFAULT_POLL_MS = 750;
const DEFAULT_CANCEL_POLL_MS = 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function consumeAndPersistDashboardRun(
  store: DashboardRunStore,
  runId: string,
  uiStream: ReadableStream<UIMessageChunk>,
  options: {
    abortController?: AbortController;
    cancelPollMs?: number;
    onDone?: () => Promise<void>;
    onError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const { abortController, onDone, onError } = options;
  const cancelPollMs = options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS;
  let cancelled = false;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;

  if (abortController) {
    cancelPoll = setInterval(() => {
      void store
        .getRun(runId)
        .then((run) => {
          if (run?.status === "cancelled") {
            cancelled = true;
            abortController.abort();
          }
        })
        .catch(() => {});
    }, cancelPollMs);
  }

  const reader = uiStream.getReader();
  let chunkIndex = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await store.appendChunk(runId, chunkIndex++, value);
    }

    await onDone?.();
    await store.finishRun(runId, "completed");
  } catch (error) {
    onError?.(error);
    if (cancelled || abortController?.signal.aborted) {
      await store.finishRun(runId, "cancelled").catch(() => {});
    } else {
      const message = errorMessage(error);
      await store
        .appendChunk(runId, chunkIndex, {
          type: "error",
          errorText: message,
        } as UIMessageChunk)
        .catch(() => {});
      await store.finishRun(runId, "failed", message).catch(() => {});
    }
  } finally {
    if (cancelPoll) clearInterval(cancelPoll);
    reader.releaseLock();
  }
}

export function createDashboardReplayStream(
  store: DashboardRunStore,
  runId: string,
  options: {
    startIndex?: number;
    pollMs?: number;
    signal?: AbortSignal;
  } = {},
): ReadableStream<UIMessageChunk> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const signal = options.signal;
  let nextIndex = Math.max(0, options.startIndex ?? 0);

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      void (async () => {
        while (!signal?.aborted) {
          const chunks = await store.getChunks(runId, nextIndex);
          for (const row of chunks) {
            controller.enqueue(row.chunk);
            nextIndex = row.chunkIndex + 1;
          }

          const run = await store.getRun(runId);
          if (!run) {
            controller.enqueue({ type: "error", errorText: "Run not found" } as UIMessageChunk);
            controller.close();
            return;
          }

          if (isTerminalRunStatus(run.status)) {
            const tail = await store.getChunks(runId, nextIndex);
            for (const row of tail) {
              controller.enqueue(row.chunk);
              nextIndex = row.chunkIndex + 1;
            }
            controller.close();
            return;
          }

          await sleep(pollMs, signal);
        }

        controller.close();
      })().catch((error) => controller.error(error));
    },
  });
}
