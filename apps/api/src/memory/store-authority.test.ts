import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// store.ts pulls in the db client + embeddings at module load; stub them so we
// can unit-test the pure provenance-authority helpers in isolation.
const dbMocks = vi.hoisted(() => {
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { insert, values, returning };
});

vi.mock("../db/client.js", () => ({
  db: {
    execute: vi.fn(),
    insert: dbMocks.insert,
  },
}));
vi.mock("../db/tx.js", () => ({ withTransaction: vi.fn() }));
vi.mock("../lib/embeddings.js", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { canSupersede, memoryAuthority, storeMemories, toDbChannelType } from "./store.js";

type StoreMemoryInput = Parameters<typeof storeMemories>[0][number];

function memory(overrides: Partial<StoreMemoryInput> = {}): StoreMemoryInput {
  return {
    workspaceId: "workspace-1",
    content: "Test memory",
    type: "fact",
    sourceChannelType: "public_channel",
    ...overrides,
  } as StoreMemoryInput;
}

describe("memory provenance authority", () => {
  it("ranks user/tool/unknown above assistant", () => {
    expect(memoryAuthority("user")).toBe(2);
    expect(memoryAuthority("tool")).toBe(2);
    expect(memoryAuthority(null)).toBe(2);
    expect(memoryAuthority(undefined)).toBe(2);
    expect(memoryAuthority("assistant")).toBe(1);
  });

  it("blocks a lower-authority assistant memory from superseding a user/tool fact", () => {
    expect(canSupersede("assistant", "user")).toBe(false);
    expect(canSupersede("assistant", "tool")).toBe(false);
    expect(canSupersede("assistant", null)).toBe(false);
  });

  it("allows equal-authority and user-correcting-assistant supersession", () => {
    // Equal authority → recency wins (Zep-style).
    expect(canSupersede("user", "user")).toBe(true);
    expect(canSupersede("assistant", "assistant")).toBe(true);
    // A user/tool statement may correct an earlier assistant inference.
    expect(canSupersede("user", "assistant")).toBe(true);
    expect(canSupersede("tool", "assistant")).toBe(true);
  });
});

describe("toDbChannelType", () => {
  it("stores MPIM as mpim instead of coercing it to dm", () => {
    expect(toDbChannelType("mpim")).toBe("mpim");
  });

  it("preserves durable Slack and dashboard channel types", () => {
    expect(toDbChannelType("dm")).toBe("dm");
    expect(toDbChannelType("public_channel")).toBe("public_channel");
    expect(toDbChannelType("private_channel")).toBe("private_channel");
    expect(toDbChannelType("dashboard")).toBe("dashboard");
  });

  it("maps virtual Slack List item events to their backing public channel", () => {
    expect(toDbChannelType("slack_list_item")).toBe("public_channel");
  });
});

describe("storeMemories temporal defaults", () => {
  const now = new Date("2026-06-09T08:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    dbMocks.insert.mockClear();
    dbMocks.values.mockClear();
    dbMocks.returning.mockReset();
    dbMocks.returning.mockResolvedValue([{ id: "memory-1" }, { id: "memory-2" }, { id: "memory-3" }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults event/open_thread validUntil while leaving durable types unexpired", async () => {
    await storeMemories([
      memory({ type: "event" }),
      memory({ type: "open_thread" }),
      memory({ type: "fact" }),
    ]);

    const inserted = dbMocks.values.mock.calls[0][0] as StoreMemoryInput[];

    expect(inserted[0].validFrom).toEqual(now);
    expect(inserted[0].validUntil).toEqual(new Date("2026-06-23T08:00:00.000Z"));
    expect(inserted[1].validFrom).toEqual(now);
    expect(inserted[1].validUntil).toEqual(new Date("2026-07-09T08:00:00.000Z"));
    expect(inserted[2].validFrom).toEqual(now);
    expect(inserted[2]).not.toHaveProperty("validUntil");
  });

  it("respects explicit durable and validUntil escape hatches", async () => {
    const explicitValidUntil = new Date("2026-12-31T00:00:00.000Z");

    await storeMemories([
      memory({ type: "event", validUntil: explicitValidUntil }),
      memory({ type: "open_thread", durable: true }),
      memory({ type: "event", validUntil: null }),
    ]);

    const inserted = dbMocks.values.mock.calls[0][0] as StoreMemoryInput[];

    expect(inserted[0].validUntil).toBe(explicitValidUntil);
    expect(inserted[1]).not.toHaveProperty("validUntil");
    expect(inserted[1]).not.toHaveProperty("durable");
    expect(inserted[2].validUntil).toBeNull();
  });

  it("bases TTLs on an explicit validFrom when replay/backfill callers provide one", async () => {
    const validFrom = new Date("2026-01-01T12:00:00.000Z");

    await storeMemories([memory({ type: "event", validFrom })]);

    const inserted = dbMocks.values.mock.calls[0][0] as StoreMemoryInput[];

    expect(inserted[0].validFrom).toBe(validFrom);
    expect(inserted[0].validUntil).toEqual(new Date("2026-01-15T12:00:00.000Z"));
  });
});
