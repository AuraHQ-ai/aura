import { describe, expect, it, vi } from "vitest";

// store.ts pulls in the db client + embeddings at module load; stub them so we
// can unit-test the pure provenance-authority helpers in isolation.
vi.mock("../db/client.js", () => ({ db: { execute: vi.fn() } }));
vi.mock("../db/tx.js", () => ({ withTransaction: vi.fn() }));
vi.mock("../lib/embeddings.js", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { canSupersede, memoryAuthority } from "./store.js";

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
