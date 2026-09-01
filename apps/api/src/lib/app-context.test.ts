import { beforeEach, describe, expect, it, vi } from "vitest";
import { appContextCache, type AppContextEntity } from "@aura/db/schema";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const mocks = vi.hoisted(() => {
  const selectLimitMock = vi.fn(async (): Promise<unknown[]> => []);
  const insertOnConflictMock = vi.fn(async () => undefined);
  const insertValuesMock = vi.fn(() => ({
    onConflictDoUpdate: insertOnConflictMock,
  }));
  return {
    selectLimitMock,
    insertOnConflictMock,
    insertValuesMock,
    dbSelectMock: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimitMock,
        })),
      })),
    })),
    dbInsertMock: vi.fn(() => ({ values: insertValuesMock })),
  };
});

vi.mock("../db/client.js", () => ({
  db: {
    select: mocks.dbSelectMock,
    insert: mocks.dbInsertMock,
  },
}));

vi.mock("./logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  APP_CONTEXT_TTL_MS,
  buildAppContextBlock,
  extractEventAppContext,
  readCachedAppContext,
  renderAppContextEntities,
  resolveAppContextForMessage,
  upsertAppContext,
} = await import("./app-context.js");

const channelEntity: AppContextEntity = {
  type: "slack#/types/channel_id",
  value: "C0123ABCDE",
  team_id: "T0123ABCDE",
};

const canvasEntity: AppContextEntity = {
  type: "slack#/types/canvas_id",
  value: "F0456CANVA",
};

function cacheRow(entities: AppContextEntity[], updatedAt: Date) {
  return {
    workspaceId: "default",
    userId: "U123",
    entities,
    eventTs: "1788249000.000100",
    updatedAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectLimitMock.mockResolvedValue([]);
});

describe("extractEventAppContext", () => {
  it("returns the entities from an inline app_context payload", () => {
    const event = { app_context: { entities: [channelEntity] } };
    expect(extractEventAppContext(event)).toEqual([channelEntity]);
  });

  it("returns null when the event has no app_context", () => {
    expect(extractEventAppContext({ type: "message" })).toBeNull();
  });

  it("returns null for an empty entities array", () => {
    expect(extractEventAppContext({ app_context: { entities: [] } })).toBeNull();
  });
});

describe("resolveAppContextForMessage", () => {
  it("prefers the fresh inline event payload over the cache", async () => {
    // A different (older) context sits in the cache — it must NOT be read.
    mocks.selectLimitMock.mockResolvedValue([
      cacheRow([canvasEntity], new Date()),
    ]);

    const entities = await resolveAppContextForMessage({
      event: { app_context: { entities: [channelEntity] } },
      userId: "U123",
    });

    expect(entities).toEqual([channelEntity]);
    expect(mocks.dbSelectMock).not.toHaveBeenCalled();
  });

  it("falls back to a fresh cached context when the event has none", async () => {
    mocks.selectLimitMock.mockResolvedValue([
      cacheRow([canvasEntity], new Date(Date.now() - 60_000)),
    ]);

    const entities = await resolveAppContextForMessage({
      event: { type: "message" },
      userId: "U123",
    });

    expect(entities).toEqual([canvasEntity]);
    expect(mocks.dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale cached context (older than the TTL)", async () => {
    mocks.selectLimitMock.mockResolvedValue([
      cacheRow([canvasEntity], new Date(Date.now() - APP_CONTEXT_TTL_MS - 1_000)),
    ]);

    const entities = await resolveAppContextForMessage({
      event: { type: "message" },
      userId: "U123",
    });

    expect(entities).toBeNull();
  });
});

describe("readCachedAppContext", () => {
  it("returns null when there is no row for the user", async () => {
    expect(await readCachedAppContext("U123", "default")).toBeNull();
  });

  it("returns null for a cached empty-entities row (user navigated away)", async () => {
    mocks.selectLimitMock.mockResolvedValue([cacheRow([], new Date())]);
    expect(await readCachedAppContext("U123", "default")).toBeNull();
  });

  it("soft-fails to null when the cache read throws", async () => {
    mocks.selectLimitMock.mockRejectedValueOnce(new Error("db down"));
    expect(await readCachedAppContext("U123", "default")).toBeNull();
  });
});

describe("upsertAppContext", () => {
  it("upserts entities keyed by workspace + user", async () => {
    await upsertAppContext({
      workspaceId: "default",
      userId: "U123",
      entities: [channelEntity],
      eventTs: "1788249000.000100",
    });

    expect(mocks.dbInsertMock).toHaveBeenCalledExactlyOnceWith(appContextCache);
    expect(mocks.insertValuesMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: "default",
        userId: "U123",
        entities: [channelEntity],
        eventTs: "1788249000.000100",
      }),
    );
    expect(mocks.insertOnConflictMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: [appContextCache.workspaceId, appContextCache.userId],
        set: expect.objectContaining({ entities: [channelEntity] }),
      }),
    );
  });
});

describe("renderAppContextEntities / buildAppContextBlock", () => {
  it("renders known entity types human-readable", () => {
    const rendered = renderAppContextEntities([
      channelEntity,
      canvasEntity,
      { type: "slack#/types/list_id", value: "F0789LISTX" },
      { type: "slack#/types/thread_ts", value: "1788249000.000200" },
    ]);

    expect(rendered).toBe(
      "a channel (<#C0123ABCDE>); a canvas (id F0456CANVA); " +
        "a Slack List (id F0789LISTX); a thread (thread_ts 1788249000.000200)",
    );
  });

  it("renders unknown entity types with a de-prefixed label", () => {
    expect(
      renderAppContextEntities([
        { type: "slack#/types/bookmark_id", value: "Bk123" },
      ]),
    ).toBe("bookmark id Bk123");
  });

  it("skips malformed entities", () => {
    expect(
      renderAppContextEntities([
        { type: "slack#/types/channel_id" } as unknown as AppContextEntity,
        channelEntity,
      ]),
    ).toBe("a channel (<#C0123ABCDE>)");
  });

  it("builds the prompt block with the artifact-first instruction", () => {
    const block = buildAppContextBlock([channelEntity]);
    expect(block).toContain("## User's current view");
    expect(block).toContain("a channel (<#C0123ABCDE>)");
    expect(block).toContain("read that artifact FIRST");
  });

  it("returns null when nothing renders", () => {
    expect(buildAppContextBlock([])).toBeNull();
    expect(
      buildAppContextBlock([{ type: "x", value: "" } as AppContextEntity]),
    ).toBeNull();
  });
});
