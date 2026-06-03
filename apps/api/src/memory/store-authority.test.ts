import { describe, expect, it, vi } from "vitest";

// store.ts pulls in the db client + embeddings at module load; stub them so we
// can unit-test the pure provenance-authority helpers in isolation.
vi.mock("../db/client.js", () => ({ db: { execute: vi.fn() } }));
vi.mock("../db/tx.js", () => ({ withTransaction: vi.fn() }));
vi.mock("../lib/embeddings.js", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { canSupersede, memoryAuthority, toDbChannelType } from "./store.js";

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
