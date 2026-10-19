import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
  supersedeMemory: vi.fn(),
  disputeMemory: vi.fn(),
  getFastModel: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    execute: mocks.dbExecute,
    update: mocks.dbUpdate,
  },
}));
vi.mock("../lib/ai.js", () => ({ getFastModel: mocks.getFastModel }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/langfuse.js", () => ({ aiTelemetry: () => undefined }));
vi.mock("ai", () => ({
  generateText: mocks.generateText,
  Output: { object: (spec: unknown) => spec },
}));
vi.mock("./store.js", async () => {
  const actual = await vi.importActual<typeof import("./store.js")>("./store.js");
  return {
    ...actual,
    supersedeMemory: mocks.supersedeMemory,
    disputeMemory: mocks.disputeMemory,
  };
});

import {
  applyFactClassAssignment,
  archiveExpiredCurrentMemories,
  resolveContradictingPair,
  type ClusterMemory,
} from "./contradiction.js";

function memory(overrides: Partial<ClusterMemory> = {}): ClusterMemory {
  return {
    id: "mem-1",
    content: "Claap access is broken",
    factClass: null,
    validFrom: new Date("2026-09-01T00:00:00.000Z"),
    validUntil: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    sourceRole: "user",
    status: "current",
    ...overrides,
  };
}

describe("archiveExpiredCurrentMemories", () => {
  beforeEach(() => {
    mocks.dbExecute.mockReset();
  });

  it("archives current rows whose valid_until has already passed", async () => {
    mocks.dbExecute.mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }] });
    await expect(archiveExpiredCurrentMemories()).resolves.toBe(2);
    const sqlText = JSON.stringify(mocks.dbExecute.mock.calls[0][0]);
    expect(sqlText).toContain("archived");
    expect(sqlText).toContain("valid_until");
    expect(sqlText).toContain("current");
  });
});

describe("applyFactClassAssignment", () => {
  beforeEach(() => {
    mocks.dbUpdate.mockReset();
    mocks.dbSet.mockReset();
    mocks.dbWhere.mockReset();
    mocks.dbWhere.mockResolvedValue(undefined);
    mocks.dbSet.mockReturnValue({ where: mocks.dbWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbSet });
  });

  it("stamps class-based validUntil only when the row has no window yet", async () => {
    const applied = await applyFactClassAssignment(memory(), "access");
    expect(applied).toBe(true);
    const setArg = mocks.dbSet.mock.calls[0][0] as {
      factClass: string;
      validUntil: Date;
    };
    expect(setArg.factClass).toBe("access");
    expect(setArg.validUntil).toEqual(new Date("2026-09-15T00:00:00.000Z"));
  });

  it("does not overwrite an existing validUntil (supersession / extraction window)", async () => {
    const applied = await applyFactClassAssignment(
      memory({ validUntil: new Date("2026-09-10T00:00:00.000Z") }),
      "tool_status",
    );
    expect(applied).toBe(true);
    const setArg = mocks.dbSet.mock.calls[0][0] as { validUntil?: Date; factClass: string };
    expect(setArg.factClass).toBe("tool_status");
    expect(setArg.validUntil).toBeUndefined();
  });

  it("skips rows the extractor already classified", async () => {
    const applied = await applyFactClassAssignment(memory({ factClass: "access" }), "pricing");
    expect(applied).toBe(false);
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
  });
});

describe("resolveContradictingPair", () => {
  beforeEach(() => {
    mocks.supersedeMemory.mockReset();
    mocks.disputeMemory.mockReset();
  });

  it("supersedes the older memory when the newer one has equal or higher authority", async () => {
    const older = memory({ id: "old", createdAt: new Date("2026-09-01") });
    const newer = memory({
      id: "new",
      content: "Claap access works now",
      createdAt: new Date("2026-10-01"),
    });
    await expect(resolveContradictingPair(older, newer, "access flipped")).resolves.toBe(
      "superseded",
    );
    expect(mocks.supersedeMemory).toHaveBeenCalledWith("old", "new");
    expect(mocks.disputeMemory).not.toHaveBeenCalled();
  });

  it("disputes a lower-authority newer claim instead of superseding the user fact", async () => {
    const older = memory({
      id: "user-fact",
      sourceRole: "user",
      createdAt: new Date("2026-09-01"),
    });
    const newer = memory({
      id: "assistant-guess",
      sourceRole: "assistant",
      createdAt: new Date("2026-10-01"),
    });
    await expect(resolveContradictingPair(older, newer, "conflict")).resolves.toBe("disputed");
    expect(mocks.supersedeMemory).not.toHaveBeenCalled();
    expect(mocks.disputeMemory).toHaveBeenCalledWith(
      "assistant-guess",
      expect.stringContaining("user-fact"),
    );
  });
});
