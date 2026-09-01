import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./settings.js", () => ({
  getConfig: vi.fn(async (_key: string, fallback?: string) => fallback ?? ""),
}));

vi.mock("../db/client.js", () => ({ db: {} }));

function gmailError(status: number, message: string) {
  const err: any = new Error(message);
  err.code = status;
  return err;
}

interface MockThread {
  messageIds: string[];
}

function createMockGmailClient(threads: Record<string, MockThread>) {
  return {
    users: {
      threads: {
        get: vi.fn(async ({ id }: { id: string }) => {
          const thread = threads[id];
          if (!thread) throw gmailError(404, "Requested entity was not found.");
          return {
            data: { messages: thread.messageIds.map((mid) => ({ id: mid })) },
          };
        }),
        modify: vi.fn(async (_args: { id: string }) => ({ data: {} })),
      },
      messages: {
        batchModify: vi.fn(async () => ({ data: {} })),
      },
    },
  };
}

describe("archiveThreadsWithClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("archives multiple threads via a single batchModify call", async () => {
    const { archiveThreadsWithClient } = await import("./gmail.js");
    const gmail = createMockGmailClient({
      "thread-1": { messageIds: ["m1", "m2"] },
      "thread-2": { messageIds: ["m3"] },
    });

    const results = await archiveThreadsWithClient(gmail, [
      "thread-1",
      "thread-2",
    ]);

    expect(results).toEqual([
      { threadId: "thread-1", status: "archived" },
      { threadId: "thread-2", status: "archived" },
    ]);

    expect(gmail.users.messages.batchModify).toHaveBeenCalledTimes(1);
    expect(gmail.users.messages.batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        ids: ["m1", "m2", "m3"],
        removeLabelIds: ["INBOX"],
      },
    });
    expect(gmail.users.threads.modify).not.toHaveBeenCalled();
  });

  it("deduplicates thread IDs before archiving", async () => {
    const { archiveThreadsWithClient } = await import("./gmail.js");
    const gmail = createMockGmailClient({
      "thread-1": { messageIds: ["m1"] },
    });

    const results = await archiveThreadsWithClient(gmail, [
      "thread-1",
      "thread-1",
    ]);

    expect(results).toEqual([{ threadId: "thread-1", status: "archived" }]);
    expect(gmail.users.threads.get).toHaveBeenCalledTimes(1);
  });

  it("reports not_found for missing threads and archives the rest", async () => {
    const { archiveThreadsWithClient } = await import("./gmail.js");
    const gmail = createMockGmailClient({
      "thread-1": { messageIds: ["m1"] },
    });

    const results = await archiveThreadsWithClient(gmail, [
      "thread-1",
      "thread-missing",
    ]);

    expect(results).toEqual([
      { threadId: "thread-1", status: "archived" },
      {
        threadId: "thread-missing",
        status: "not_found",
        error: "Thread not found in Gmail",
      },
    ]);
    expect(gmail.users.messages.batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { ids: ["m1"], removeLabelIds: ["INBOX"] },
    });
  });

  it("falls back to per-thread modify when batchModify fails, reporting partial failure", async () => {
    const { archiveThreadsWithClient } = await import("./gmail.js");
    const gmail = createMockGmailClient({
      "thread-1": { messageIds: ["m1"] },
      "thread-2": { messageIds: ["m2"] },
    });
    gmail.users.messages.batchModify.mockRejectedValueOnce(
      gmailError(500, "Backend Error"),
    );
    gmail.users.threads.modify.mockImplementation(async ({ id }: any) => {
      if (id === "thread-2") throw gmailError(500, "Backend Error");
      return { data: {} };
    });

    const results = await archiveThreadsWithClient(gmail, [
      "thread-1",
      "thread-2",
    ]);

    expect(results).toEqual([
      { threadId: "thread-1", status: "archived" },
      { threadId: "thread-2", status: "failed", error: "Backend Error" },
    ]);
    expect(gmail.users.threads.modify).toHaveBeenCalledTimes(2);
  });

  it("reports failed with the Gmail error when permission is denied", async () => {
    const { archiveThreadsWithClient } = await import("./gmail.js");
    const gmail = createMockGmailClient({
      "thread-1": { messageIds: ["m1"] },
    });
    const denied = gmailError(403, "Insufficient Permission");
    gmail.users.messages.batchModify.mockRejectedValue(denied);
    gmail.users.threads.modify.mockRejectedValue(denied);

    const results = await archiveThreadsWithClient(gmail, ["thread-1"]);

    expect(results).toEqual([
      {
        threadId: "thread-1",
        status: "failed",
        error: "Insufficient Permission",
      },
    ]);
  });

  it("never reports archived when every thread fails", async () => {
    const { archiveThreadsWithClient } = await import("./gmail.js");
    const gmail = createMockGmailClient({});
    gmail.users.threads.get.mockRejectedValue(
      gmailError(429, "Rate limit exceeded"),
    );

    const results = await archiveThreadsWithClient(gmail, [
      "thread-1",
      "thread-2",
    ]);

    expect(results.every((r) => r.status === "failed")).toBe(true);
    expect(gmail.users.messages.batchModify).not.toHaveBeenCalled();
  });
});
