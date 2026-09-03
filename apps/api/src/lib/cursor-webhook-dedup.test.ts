import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const mocks = vi.hoisted(() => ({
  returningMock: vi.fn(),
  deleteWhereMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: mocks.returningMock,
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: mocks.deleteWhereMock,
    })),
  },
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.loggerWarnMock,
    error: vi.fn(),
  },
}));

const {
  claimCursorWebhook,
  cursorWebhookLockKey,
  releaseCursorWebhookClaim,
  releaseCursorWebhookLocks,
} = await import("./cursor-webhook-dedup.js");

describe("cursorWebhookLockKey", () => {
  it("collapses finished/completed onto one key", () => {
    expect(cursorWebhookLockKey("bc-1", "FINISHED", "wh-a")).toBe(
      cursorWebhookLockKey("bc-1", "completed", "wh-b"),
    );
  });

  it("collapses error/failed onto one key", () => {
    expect(cursorWebhookLockKey("bc-1", "ERROR", "wh-a")).toBe(
      cursorWebhookLockKey("bc-1", "failed", "wh-b"),
    );
  });

  it("keeps success and failure outcomes distinct", () => {
    expect(cursorWebhookLockKey("bc-1", "finished", "")).not.toBe(
      cursorWebhookLockKey("bc-1", "error", ""),
    );
  });

  it("keeps different agents distinct", () => {
    expect(cursorWebhookLockKey("bc-1", "finished", "")).not.toBe(
      cursorWebhookLockKey("bc-2", "finished", ""),
    );
  });

  it("falls back to the webhook id when there is no agent id", () => {
    expect(cursorWebhookLockKey("", "finished", "wh-a")).toBe(
      "cursor-webhook:wh-a",
    );
  });

  it("returns an empty key when there is nothing to key on", () => {
    expect(cursorWebhookLockKey("", "", "")).toBe("");
  });
});

describe("claimCursorWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims the first delivery and rejects the second", async () => {
    mocks.returningMock.mockResolvedValueOnce([{ id: "row-1" }]);
    expect(await claimCursorWebhook("cursor-agent:bc-1:finished")).toBe(true);

    mocks.returningMock.mockResolvedValueOnce([]);
    expect(await claimCursorWebhook("cursor-agent:bc-1:finished")).toBe(false);
  });

  it("processes when there is no key to claim", async () => {
    expect(await claimCursorWebhook("")).toBe(true);
    expect(mocks.returningMock).not.toHaveBeenCalled();
  });

  it("fails open when the lock table is unreachable", async () => {
    mocks.returningMock.mockRejectedValueOnce(new Error("connection refused"));
    expect(await claimCursorWebhook("cursor-agent:bc-1:finished")).toBe(true);
    expect(mocks.loggerWarnMock).toHaveBeenCalled();
  });
});

describe("releaseCursorWebhookClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteWhereMock.mockResolvedValue(undefined);
  });

  it("gives the lock back so a redelivery can retry after a failure", async () => {
    await releaseCursorWebhookClaim("cursor-agent:bc-1:finished");
    expect(mocks.deleteWhereMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a key", async () => {
    await releaseCursorWebhookClaim("");
    expect(mocks.deleteWhereMock).not.toHaveBeenCalled();
  });
});

describe("releaseCursorWebhookLocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteWhereMock.mockResolvedValue(undefined);
  });

  it("clears both terminal outcomes so a follow-up run can notify again", async () => {
    await releaseCursorWebhookLocks("bc-1");
    expect(mocks.deleteWhereMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing without an agent id", async () => {
    await releaseCursorWebhookLocks("");
    expect(mocks.deleteWhereMock).not.toHaveBeenCalled();
  });

  it("swallows delete failures", async () => {
    mocks.deleteWhereMock.mockRejectedValue(new Error("boom"));
    await expect(releaseCursorWebhookLocks("bc-1")).resolves.toBeUndefined();
    expect(mocks.loggerWarnMock).toHaveBeenCalled();
  });
});
