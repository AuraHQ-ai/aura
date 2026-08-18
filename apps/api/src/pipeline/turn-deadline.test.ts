import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    insertError: null as Error | null,
    insertValues: [] as Record<string, unknown>[],
    insert: vi.fn(),
  };

  state.insert.mockImplementation(() => ({
    values: vi.fn((valuesArg: Record<string, unknown>) => {
      state.insertValues.push(valuesArg);
      return state.insertError
        ? Promise.reject(state.insertError)
        : Promise.resolve([]);
    }),
  }));

  return state;
});

vi.mock("../db/client.js", () => ({
  db: {
    insert: dbMock.insert,
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  TURN_SOFT_DEADLINE_MS,
  TURN_HARD_DEADLINE_MS,
  resolveTurnDeadlines,
  spawnTurnContinuationJob,
} from "./turn-deadline.js";
import { logger } from "../lib/logger.js";

describe("resolveTurnDeadlines", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the defaults when no env overrides are set", () => {
    expect(resolveTurnDeadlines("interactive")).toEqual({
      softDeadlineMs: TURN_SOFT_DEADLINE_MS,
      hardDeadlineMs: TURN_HARD_DEADLINE_MS,
    });
    expect(resolveTurnDeadlines("headless")).toEqual({
      softDeadlineMs: TURN_SOFT_DEADLINE_MS,
      hardDeadlineMs: TURN_HARD_DEADLINE_MS,
    });
  });

  it("honors TURN_SOFT_DEADLINE_MS / TURN_HARD_DEADLINE_MS overrides on both paths", () => {
    vi.stubEnv("TURN_SOFT_DEADLINE_MS", "500000");
    vi.stubEnv("TURN_HARD_DEADLINE_MS", "650000");

    expect(resolveTurnDeadlines("interactive")).toEqual({
      softDeadlineMs: 500_000,
      hardDeadlineMs: 650_000,
    });
    expect(resolveTurnDeadlines("headless")).toEqual({
      softDeadlineMs: 500_000,
      hardDeadlineMs: 650_000,
    });
  });

  it("lets the headless path override its budgets independently", () => {
    vi.stubEnv("TURN_HARD_DEADLINE_MS", "650000");
    vi.stubEnv("HEADLESS_TURN_SOFT_DEADLINE_MS", "400000");
    vi.stubEnv("HEADLESS_TURN_HARD_DEADLINE_MS", "550000");

    expect(resolveTurnDeadlines("headless")).toEqual({
      softDeadlineMs: 400_000,
      hardDeadlineMs: 550_000,
    });
    // Interactive path is unaffected by the headless-specific vars.
    expect(resolveTurnDeadlines("interactive")).toEqual({
      softDeadlineMs: TURN_SOFT_DEADLINE_MS,
      hardDeadlineMs: 650_000,
    });
  });

  it("ignores invalid or non-positive env values", () => {
    vi.stubEnv("TURN_SOFT_DEADLINE_MS", "not-a-number");
    vi.stubEnv("TURN_HARD_DEADLINE_MS", "-1");

    expect(resolveTurnDeadlines("interactive")).toEqual({
      softDeadlineMs: TURN_SOFT_DEADLINE_MS,
      hardDeadlineMs: TURN_HARD_DEADLINE_MS,
    });
  });
});

describe("spawnTurnContinuationJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.insertError = null;
    dbMock.insertValues = [];
  });

  it("inserts a [CONTINUE:...] job carrying the thread metadata", async () => {
    const ok = await spawnTurnContinuationJob({
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      userId: "U0999",
      invocationId: "abcd1234-5678-90ab-cdef-000000000000",
      elapsedMs: 723_456,
      step: 41,
    });

    expect(ok).toBe(true);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.insertValues).toHaveLength(1);

    const row = dbMock.insertValues[0];
    expect(row.channelId).toBe("C0123456");
    expect(row.threadTs).toBe("1755500000.000100");
    expect(row.requestedBy).toBe("U0999");
    expect(row.priority).toBe("high");
    expect(row.executeAt).toBeInstanceOf(Date);
    expect(row.description).toMatch(/^\[CONTINUE:turn-deadline-abcd1234\] /);
    expect(row.description).toContain("C0123456");
    expect(row.description).toContain("1755500000.000100");
    expect(row.description).toContain("723s");
    expect(row.description).toContain("step 41");
  });

  it("defaults requestedBy and channel routing when context is missing", async () => {
    const ok = await spawnTurnContinuationJob({
      elapsedMs: 720_000,
      step: 12,
    });

    expect(ok).toBe(true);
    const row = dbMock.insertValues[0];
    expect(row.channelId).toBe("");
    expect(row.threadTs).toBeNull();
    expect(row.requestedBy).toBe("aura");
  });

  it("is fail-soft: returns false and logs when the insert throws", async () => {
    dbMock.insertError = new Error("db down");

    const ok = await spawnTurnContinuationJob({
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      elapsedMs: 720_000,
      step: 12,
    });

    expect(ok).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "turn-deadline: failed to spawn continuation job",
      expect.objectContaining({ error: "db down" }),
    );
  });
});
