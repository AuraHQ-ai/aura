import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "select" | "update";
    setArg?: Record<string, unknown>;
  };

  const state = {
    results: [] as unknown[][],
    operations: [] as Operation[],
    select: vi.fn(),
    update: vi.fn(),
  };

  function nextResult() {
    return state.results.shift() ?? [];
  }

  function createQuery(operation: Operation) {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => {
        state.operations.push(operation);
        return Promise.resolve(nextResult());
      }),
      set: vi.fn((setArg: Record<string, unknown>) => {
        operation.setArg = setArg;
        return query;
      }),
      returning: vi.fn(() => {
        state.operations.push(operation);
        return Promise.resolve(nextResult());
      }),
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery({ kind: "select" }));
  state.update.mockImplementation(() => createQuery({ kind: "update" }));

  return state;
});

const logErrorMock = vi.hoisted(() => vi.fn());
const safePostMessageMock = vi.hoisted(() => vi.fn());
const cleanupOldTurnMarkersMock = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
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

vi.mock("../lib/error-logger.js", () => ({
  logError: logErrorMock,
}));

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: safePostMessageMock,
}));

vi.mock("../lib/turn-markers.js", () => ({
  cleanupOldTurnMarkers: cleanupOldTurnMarkersMock,
}));

import {
  sweepStaleTurnMarkers,
  turnWatchdogStaleMs,
  TURN_RECOVERY_MESSAGE,
} from "./turn-watchdog.js";
import { logger } from "../lib/logger.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");

function staleMarker(overrides: Record<string, unknown> = {}) {
  return {
    id: "marker-1",
    workspaceId: "default",
    invocationId: "inv-1",
    channelId: "C123",
    threadTs: "1710000000.000000",
    messageTs: "1710000001.000100",
    userId: "U123",
    status: "started",
    startedAt: new Date(NOW.getTime() - 20 * 60 * 1000),
    endedAt: null,
    ...overrides,
  };
}

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

function updateSets() {
  return dbMock.operations
    .filter((operation) => operation.kind === "update")
    .map((operation) => operation.setArg ?? {});
}

const slackClient = {} as any;

describe("turn watchdog sweep", () => {
  const originalStaleMinutes = process.env.TURN_WATCHDOG_STALE_MINUTES;

  beforeEach(() => {
    dbMock.results = [];
    dbMock.operations = [];
    vi.clearAllMocks();
    safePostMessageMock.mockResolvedValue({ ok: true });
    cleanupOldTurnMarkersMock.mockResolvedValue(0);
    delete process.env.TURN_WATCHDOG_STALE_MINUTES;
  });

  afterEach(() => {
    if (originalStaleMinutes === undefined) {
      delete process.env.TURN_WATCHDOG_STALE_MINUTES;
    } else {
      process.env.TURN_WATCHDOG_STALE_MINUTES = originalStaleMinutes;
    }
  });

  it("detects a stale marker: error row + one recovery message + marker recovered", async () => {
    queueDbResults(
      [staleMarker()], // stale started markers
      [{ id: "marker-1" }], // atomic claim succeeds
    );

    const result = await sweepStaleTurnMarkers(slackClient, NOW);

    expect(result).toEqual({ detected: 1, recovered: 1 });

    expect(updateSets()).toEqual([
      expect.objectContaining({ status: "recovered", endedAt: expect.any(Date) }),
    ]);

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: "TurnKilledDetected",
        errorCode: "turn_killed_detected",
        channelId: "C123",
        userId: "U123",
        context: expect.objectContaining({
          invocationId: "inv-1",
          threadTs: "1710000000.000000",
          messageTs: "1710000001.000100",
          ageMs: 20 * 60 * 1000,
          recovered_by: "heartbeat",
        }),
      }),
    );

    expect(safePostMessageMock).toHaveBeenCalledTimes(1);
    expect(safePostMessageMock).toHaveBeenCalledWith(slackClient, {
      channel: "C123",
      text: TURN_RECOVERY_MESSAGE,
      thread_ts: "1710000000.000000",
    });
  });

  it("never posts twice: a recovered marker no longer matches the next sweep", async () => {
    // First sweep: marker is stale, claim succeeds, one message posted.
    queueDbResults([staleMarker()], [{ id: "marker-1" }]);
    await sweepStaleTurnMarkers(slackClient, NOW);
    expect(safePostMessageMock).toHaveBeenCalledTimes(1);

    // Second sweep: the status = 'started' filter no longer matches the
    // recovered marker, so the select returns nothing.
    queueDbResults([]);
    const second = await sweepStaleTurnMarkers(slackClient, NOW);

    expect(second).toEqual({ detected: 0, recovered: 0 });
    expect(safePostMessageMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it("skips a marker whose atomic claim was lost to a concurrent sweep", async () => {
    queueDbResults(
      [staleMarker()],
      [], // claim update matched no row — another sweep got there first
    );

    const result = await sweepStaleTurnMarkers(slackClient, NOW);

    expect(result).toEqual({ detected: 1, recovered: 0 });
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(safePostMessageMock).not.toHaveBeenCalled();
  });

  it("produces zero output when no markers are stale", async () => {
    queueDbResults([]);

    const result = await sweepStaleTurnMarkers(slackClient, NOW);

    expect(result).toEqual({ detected: 0, recovered: 0 });
    expect(updateSets()).toEqual([]);
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(safePostMessageMock).not.toHaveBeenCalled();
  });

  it("keeps the marker recovered (no retry) when the recovery post fails", async () => {
    queueDbResults([staleMarker()], [{ id: "marker-1" }]);
    safePostMessageMock.mockRejectedValueOnce(new Error("slack down"));

    const result = await sweepStaleTurnMarkers(slackClient, NOW);

    expect(result).toEqual({ detected: 1, recovered: 1 });
    expect(updateSets()).toEqual([
      expect.objectContaining({ status: "recovered" }),
    ]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "turn_watchdog_recovery_post_error",
      expect.objectContaining({ invocationId: "inv-1", error: "slack down" }),
    );
  });

  it("posts without thread_ts when the marker has none", async () => {
    queueDbResults([staleMarker({ threadTs: null })], [{ id: "marker-1" }]);

    await sweepStaleTurnMarkers(slackClient, NOW);

    expect(safePostMessageMock).toHaveBeenCalledWith(slackClient, {
      channel: "C123",
      text: TURN_RECOVERY_MESSAGE,
    });
  });

  it("never throws even when the DB query fails", async () => {
    dbMock.select.mockImplementationOnce(() => {
      throw new Error("db unreachable");
    });

    await expect(sweepStaleTurnMarkers(slackClient, NOW)).resolves.toEqual({
      detected: 0,
      recovered: 0,
    });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "turn_watchdog_sweep_failed",
      expect.objectContaining({ error: "db unreachable" }),
    );
  });

  it("garbage-collects old terminal markers each sweep", async () => {
    queueDbResults([]);

    await sweepStaleTurnMarkers(slackClient, NOW);

    expect(cleanupOldTurnMarkersMock).toHaveBeenCalledTimes(1);
    const cutoff = cleanupOldTurnMarkersMock.mock.calls[0][0] as Date;
    expect(cutoff.getTime()).toBe(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  describe("turnWatchdogStaleMs", () => {
    it("defaults to 15 minutes", () => {
      expect(turnWatchdogStaleMs()).toBe(15 * 60 * 1000);
    });

    it("honors TURN_WATCHDOG_STALE_MINUTES", () => {
      process.env.TURN_WATCHDOG_STALE_MINUTES = "30";
      expect(turnWatchdogStaleMs()).toBe(30 * 60 * 1000);
    });

    it("falls back to the default for invalid values", () => {
      process.env.TURN_WATCHDOG_STALE_MINUTES = "not-a-number";
      expect(turnWatchdogStaleMs()).toBe(15 * 60 * 1000);
      process.env.TURN_WATCHDOG_STALE_MINUTES = "-5";
      expect(turnWatchdogStaleMs()).toBe(15 * 60 * 1000);
    });
  });
});
