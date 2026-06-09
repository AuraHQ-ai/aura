import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";
import {
  consumeAndPersistDashboardRun,
  createDashboardReplayStream,
  isTerminalRunStatus,
  type DashboardRunRecord,
  type DashboardRunStatus,
  type DashboardRunStore,
  type StoredDashboardChunk,
} from "./dashboard-run-store.js";

function makeMemoryStore(): DashboardRunStore & {
  runs: Map<string, DashboardRunRecord>;
  chunks: Map<string, StoredDashboardChunk[]>;
} {
  const runs = new Map<string, DashboardRunRecord>();
  const chunks = new Map<string, StoredDashboardChunk[]>();
  let counter = 0;

  return {
    runs,
    chunks,
    async createRun(input) {
      const id = input.id ?? `run-${++counter}`;
      runs.set(id, {
        id,
        threadId: input.threadId,
        userId: input.userId,
        userName: input.userName ?? null,
        messageId: input.messageId,
        prompt: input.prompt,
        inputMessages: input.inputMessages ?? null,
        modelId: input.modelId ?? null,
        status: "generating",
        error: null,
      });
      chunks.set(id, []);
      return id;
    },
    async updateModelId(runId, modelId) {
      const run = runs.get(runId);
      if (run) run.modelId = modelId;
    },
    async appendChunk(runId, chunkIndex, chunk) {
      const list = chunks.get(runId) ?? [];
      if (!list.some((item) => item.chunkIndex === chunkIndex)) {
        list.push({ chunkIndex, chunk });
      }
      list.sort((a, b) => a.chunkIndex - b.chunkIndex);
      chunks.set(runId, list);
    },
    async getChunks(runId, fromIndex) {
      return (chunks.get(runId) ?? []).filter((chunk) => chunk.chunkIndex >= fromIndex);
    },
    async getTailIndex(runId) {
      const list = chunks.get(runId) ?? [];
      return list.length === 0 ? -1 : list[list.length - 1]!.chunkIndex;
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async finishRun(runId, status, error) {
      const run = runs.get(runId);
      if (run && run.status === "generating") {
        run.status = status;
        run.error = error ?? null;
      }
    },
    async requestCancel(runId) {
      const run = runs.get(runId);
      if (run && run.status === "generating") run.status = "cancelled";
    },
    async getActiveRunForThread(threadId) {
      for (const run of [...runs.values()].reverse()) {
        if (run.threadId === threadId && run.status === "generating") return run;
      }
      return null;
    },
  };
}

function chunk(text: string): UIMessageChunk {
  return { type: "text-delta", id: "text-1", delta: text } as UIMessageChunk;
}

function streamFromChunks(
  chunks: UIMessageChunk[],
  options: { delayMs?: number; signal?: AbortSignal } = {},
): ReadableStream<UIMessageChunk> {
  let index = 0;
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (options.signal?.aborted) {
        controller.error(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]!);
    },
  });
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const output: UIMessageChunk[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output.push(value);
  }

  return output;
}

describe("dashboard run store", () => {
  it("persists every chunk and marks the run completed", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({
      threadId: "thread-1",
      userId: "user-1",
      messageId: "message-1",
      prompt: "hello",
    });

    await consumeAndPersistDashboardRun(store, runId, streamFromChunks([
      chunk("a"),
      chunk("b"),
      chunk("c"),
    ]));

    expect((await store.getChunks(runId, 0)).map((item) => item.chunkIndex)).toEqual([0, 1, 2]);
    expect((await store.getRun(runId))?.status).toBe("completed");
  });

  it("replays from a cursor and tails newly persisted chunks", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({
      threadId: "thread-1",
      userId: "user-1",
      messageId: "message-1",
      prompt: "hello",
    });

    const writer = consumeAndPersistDashboardRun(
      store,
      runId,
      streamFromChunks([chunk("0"), chunk("1"), chunk("2"), chunk("3")], { delayMs: 10 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [replayed] = await Promise.all([
      drain(createDashboardReplayStream(store, runId, { startIndex: 1, pollMs: 5 })),
      writer,
    ]);

    expect(replayed.map((item) => (item as { delta: string }).delta)).toEqual(["1", "2", "3"]);
  });

  it("detaching a replay reader does not cancel server-side generation", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({
      threadId: "thread-1",
      userId: "user-1",
      messageId: "message-1",
      prompt: "hello",
    });

    const writer = consumeAndPersistDashboardRun(
      store,
      runId,
      streamFromChunks([chunk("0"), chunk("1"), chunk("2")], { delayMs: 10 }),
    );
    const detach = new AbortController();
    const reader = createDashboardReplayStream(store, runId, {
      startIndex: 0,
      pollMs: 5,
      signal: detach.signal,
    }).getReader();

    await reader.read();
    detach.abort();
    await reader.read();
    await writer;

    expect((await store.getRun(runId))?.status).toBe("completed");
    expect(await store.getTailIndex(runId)).toBe(2);
  });

  it("cancels generation only when the run is explicitly cancelled", async () => {
    const store = makeMemoryStore();
    const runId = await store.createRun({
      threadId: "thread-1",
      userId: "user-1",
      messageId: "message-1",
      prompt: "hello",
    });
    const abortController = new AbortController();
    const chunks = Array.from({ length: 100 }, (_, index) => chunk(String(index)));

    const writer = consumeAndPersistDashboardRun(
      store,
      runId,
      streamFromChunks(chunks, { delayMs: 5, signal: abortController.signal }),
      { abortController, cancelPollMs: 5 },
    );
    setTimeout(() => void store.requestCancel(runId), 20);
    await writer;

    expect((await store.getRun(runId))?.status).toBe("cancelled");
    expect((await store.getChunks(runId, 0)).length).toBeLessThan(chunks.length);
  });

  it("classifies terminal statuses", () => {
    const cases: [DashboardRunStatus, boolean][] = [
      ["generating", false],
      ["completed", true],
      ["failed", true],
      ["cancelled", true],
    ];

    for (const [status, expected] of cases) {
      expect(isTerminalRunStatus(status)).toBe(expected);
    }
  });
});
