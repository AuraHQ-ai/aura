import { describe, it, expect } from "vitest";
import type { UIMessageChunk } from "ai";
import {
  consumeAndPersist,
  createReplayStream,
  isRunStale,
  isTerminal,
  RUN_STALE_MS,
  type ChatRunRecord,
  type ChatRunStatus,
  type RunStore,
  type StoredChunk,
} from "./run-store.js";

/** In-memory RunStore for tests — no database. */
function makeMemoryStore(): RunStore & {
  _runs: Map<string, ChatRunRecord>;
  _chunks: Map<string, StoredChunk[]>;
  _touched: Map<string, number>;
} {
  const runs = new Map<string, ChatRunRecord>();
  const chunks = new Map<string, StoredChunk[]>();
  const touched = new Map<string, number>();
  let counter = 0;

  return {
    _runs: runs,
    _chunks: chunks,
    _touched: touched,
    async createRun(input) {
      const id = `run-${++counter}`;
      runs.set(id, {
        id,
        threadId: input.threadId,
        userId: input.userId ?? null,
        modelId: input.modelId ?? null,
        status: "running",
        inputMessages: input.inputMessages ?? null,
        error: null,
      });
      chunks.set(id, []);
      return id;
    },
    async appendChunk(runId, seq, chunk) {
      const list = chunks.get(runId) ?? [];
      if (!list.some((c) => c.seq === seq)) list.push({ seq, chunk });
      list.sort((a, b) => a.seq - b.seq);
      chunks.set(runId, list);
    },
    async getChunks(runId, fromSeq) {
      return (chunks.get(runId) ?? []).filter((c) => c.seq >= fromSeq);
    },
    async getTailIndex(runId) {
      const list = chunks.get(runId) ?? [];
      return list.length === 0 ? 0 : list[list.length - 1]!.seq + 1;
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async touchRun(runId) {
      touched.set(runId, (touched.get(runId) ?? 0) + 1);
    },
    async finishRun(runId, status, error) {
      const run = runs.get(runId);
      if (run && run.status === "running") {
        run.status = status;
        run.error = error ?? null;
      }
    },
    async requestCancel(runId) {
      const run = runs.get(runId);
      if (run && run.status === "running") run.status = "canceled";
    },
    async getActiveRunForThread(threadId) {
      for (const run of [...runs.values()].reverse()) {
        if (run.threadId === threadId && run.status === "running") return run;
      }
      return null;
    },
    async getGeneratingThreads(threadIds) {
      const set = new Set<string>();
      for (const run of runs.values()) {
        if (run.status === "running" && threadIds.includes(run.threadId)) set.add(run.threadId);
      }
      return set;
    },
  };
}

function streamFromChunks(
  chunks: UIMessageChunk[],
  opts: { delayMs?: number; signal?: AbortSignal } = {},
): ReadableStream<UIMessageChunk> {
  let i = 0;
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (opts.signal?.aborted) {
        controller.error(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]!);
    },
  });
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const text = (t: string): UIMessageChunk => ({ type: "text-delta", id: "1", delta: t } as UIMessageChunk);

describe("run-store: consumeAndPersist", () => {
  it("persists every chunk in order and marks the run done", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({ threadId: "t1" });
    await consumeAndPersist(store, runId, streamFromChunks([text("a"), text("b"), text("c")]));

    const chunks = await store.getChunks(runId, 0);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect((await store.getRun(runId))!.status).toBe("done");
  });

  it("marks the run errored when the model stream throws", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({ threadId: "t1" });
    const bad = new ReadableStream<UIMessageChunk>({
      pull(controller) {
        controller.error(new Error("model blew up"));
      },
    });
    await consumeAndPersist(store, runId, bad);
    const run = (await store.getRun(runId))!;
    expect(run.status).toBe("error");
    expect(run.error).toContain("model blew up");
  });

  it("cancels the run server-side when status flips to canceled (explicit stop)", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({ threadId: "t1" });
    const abortController = new AbortController();
    // A long stream that respects the abort signal.
    const longChunks = Array.from({ length: 1000 }, (_, i) => text(`x${i}`));
    const stream = streamFromChunks(longChunks, { delayMs: 5, signal: abortController.signal });

    const persistPromise = consumeAndPersist(store, runId, stream, {
      abortController,
      cancelPollMs: 10,
    });
    // Simulate an out-of-band explicit stop from another tab/device.
    setTimeout(() => void store.requestCancel(runId), 30);
    await persistPromise;

    const run = (await store.getRun(runId))!;
    expect(run.status).toBe("canceled");
    // It must have stopped early, not persisted all 1000 chunks.
    expect((await store.getChunks(runId, 0)).length).toBeLessThan(longChunks.length);
  });
});

describe("run-store: createReplayStream", () => {
  it("replays a completed run fully from the start (T6 completed-run replay)", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({ threadId: "t1" });
    await consumeAndPersist(store, runId, streamFromChunks([text("hello "), text("world")]));

    const replayed = await drain(createReplayStream(store, runId, { startIndex: 0 }));
    expect(replayed).toEqual([text("hello "), text("world")]);
  });

  it("replays from a cursor without dupes, then tails live chunks (T3)", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({ threadId: "t1" });

    // Writer produces chunks slowly in the background.
    const writer = consumeAndPersist(
      store,
      runId,
      streamFromChunks([text("0"), text("1"), text("2"), text("3"), text("4")], { delayMs: 15 }),
    );

    // Wait until a couple chunks landed, then attach a reader from seq 1.
    await new Promise((r) => setTimeout(r, 25));
    const reader = createReplayStream(store, runId, { startIndex: 1, pollMs: 5 });
    const [tail] = await Promise.all([drain(reader), writer]);

    // No chunk 0 (we started at 1), no dupes, ends with the final chunk.
    expect(tail.map((c) => (c as { delta: string }).delta)).toEqual(["1", "2", "3", "4"]);
    expect((await store.getRun(runId))!.status).toBe("done");
  });

  it("detaching a reader (abort) does NOT cancel the run (disconnect footgun guard, T5)", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({ threadId: "t1" });

    const writer = consumeAndPersist(
      store,
      runId,
      streamFromChunks([text("0"), text("1"), text("2"), text("3")], { delayMs: 20 }),
    );

    const detach = new AbortController();
    const reader = createReplayStream(store, runId, { startIndex: 0, pollMs: 5, signal: detach.signal });
    // Read one chunk then bail (simulates tab close / refresh).
    const r = reader.getReader();
    await r.read();
    detach.abort();
    await r.read().catch(() => {});

    // The run keeps going server-side and completes normally.
    await writer;
    const run = (await store.getRun(runId))!;
    expect(run.status).toBe("done");
    expect((await store.getChunks(runId, 0)).length).toBe(4);
  });

  it("emits a terminating error chunk for an unknown run", async () => {
    const store = makeMemoryStore();
    const out = await drain(createReplayStream(store, "nope", { startIndex: 0 }));
    expect(out).toHaveLength(1);
    expect((out[0] as { type: string }).type).toBe("error");
  });
});

describe("run-store: helpers", () => {
  it("classifies terminal statuses", () => {
    const cases: [ChatRunStatus, boolean][] = [
      ["running", false],
      ["done", true],
      ["error", true],
      ["canceled", true],
    ];
    for (const [status, expected] of cases) expect(isTerminal(status)).toBe(expected);
  });

  it("flags a run as stale only past the heartbeat threshold (dead-writer guard)", () => {
    const now = 1_000_000;
    expect(isRunStale(now - 1000, now)).toBe(false); // 1s ago — alive
    expect(isRunStale(now - (RUN_STALE_MS - 1), now)).toBe(false); // just under threshold
    expect(isRunStale(now - (RUN_STALE_MS + 1), now)).toBe(true); // just over — stale
    expect(isRunStale(new Date(now - RUN_STALE_MS - 5000), now)).toBe(true); // accepts Date
    expect(isRunStale("not-a-date", now)).toBe(false); // never reap on bad input
  });

  it("heartbeats while the writer is alive so liveness != chunk cadence", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({ threadId: "t1" });
    // A long, quiet stream (one chunk, then a 60ms gap before close).
    const slow = new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 60));
        controller.close();
      },
    });
    await consumeAndPersist(store, runId, slow, { heartbeatMs: 10 });
    // It heartbeat several times despite producing no chunks.
    expect(store._touched.get(runId) ?? 0).toBeGreaterThan(2);
  });
});
