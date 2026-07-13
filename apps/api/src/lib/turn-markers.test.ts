import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    insertError: null as Error | null,
    updateError: null as Error | null,
    deleteError: null as Error | null,
    deleteResult: [] as unknown[],
    insertValues: [] as Record<string, unknown>[],
    updateSets: [] as Record<string, unknown>[],
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  state.insert.mockImplementation(() => ({
    values: vi.fn((valuesArg: Record<string, unknown>) => {
      state.insertValues.push(valuesArg);
      return {
        onConflictDoNothing: vi.fn(() =>
          state.insertError
            ? Promise.reject(state.insertError)
            : Promise.resolve([]),
        ),
      };
    }),
  }));

  state.update.mockImplementation(() => ({
    set: vi.fn((setArg: Record<string, unknown>) => {
      state.updateSets.push(setArg);
      return {
        where: vi.fn(() =>
          state.updateError
            ? Promise.reject(state.updateError)
            : Promise.resolve([]),
        ),
      };
    }),
  }));

  state.delete.mockImplementation(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(() =>
        state.deleteError
          ? Promise.reject(state.deleteError)
          : Promise.resolve(state.deleteResult),
      ),
    })),
  }));

  return state;
});

vi.mock("../db/client.js", () => ({
  db: {
    insert: dbMock.insert,
    update: dbMock.update,
    delete: dbMock.delete,
  },
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  startTurnMarker,
  finishTurnMarker,
  cleanupOldTurnMarkers,
} from "./turn-markers.js";
import { logger } from "./logger.js";

describe("turn markers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.insertError = null;
    dbMock.updateError = null;
    dbMock.deleteError = null;
    dbMock.deleteResult = [];
    dbMock.insertValues = [];
    dbMock.updateSets = [];
  });

  it("startTurnMarker inserts a started marker row", async () => {
    await startTurnMarker({
      invocationId: "inv-1",
      channelId: "C123",
      threadTs: "1710000000.000000",
      messageTs: "1710000001.000100",
      userId: "U123",
      workspaceId: "ws-1",
    });

    expect(dbMock.insertValues).toEqual([
      {
        workspaceId: "ws-1",
        invocationId: "inv-1",
        channelId: "C123",
        threadTs: "1710000000.000000",
        messageTs: "1710000001.000100",
        userId: "U123",
      },
    ]);
  });

  it("startTurnMarker defaults workspaceId and never throws on DB errors", async () => {
    dbMock.insertError = new Error("connection refused");

    await expect(
      startTurnMarker({ invocationId: "inv-2", channelId: "C123" }),
    ).resolves.toBeUndefined();

    expect(dbMock.insertValues[0]).toMatchObject({ workspaceId: "default" });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "turn_marker_start_failed",
      expect.objectContaining({ invocationId: "inv-2", error: "connection refused" }),
    );
  });

  it("finishTurnMarker sets the terminal status and endedAt", async () => {
    await finishTurnMarker("inv-3", "completed");

    expect(dbMock.updateSets).toEqual([
      expect.objectContaining({ status: "completed", endedAt: expect.any(Date) }),
    ]);
  });

  it("finishTurnMarker never throws on DB errors", async () => {
    dbMock.updateError = new Error("timeout");

    await expect(finishTurnMarker("inv-4", "failed")).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "turn_marker_finish_failed",
      expect.objectContaining({ invocationId: "inv-4", status: "failed", error: "timeout" }),
    );
  });

  it("cleanupOldTurnMarkers returns the deleted count and never throws", async () => {
    dbMock.deleteResult = [{ id: "a" }, { id: "b" }];
    await expect(cleanupOldTurnMarkers(new Date())).resolves.toBe(2);

    dbMock.deleteError = new Error("boom");
    await expect(cleanupOldTurnMarkers(new Date())).resolves.toBe(0);
  });
});
