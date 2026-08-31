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

const errorLoggerMocks = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../lib/error-logger.js", () => ({
  logError: errorLoggerMocks.logError,
}));

const slackMessagingMocks = vi.hoisted(() => ({
  safePostMessage: vi.fn(
    async (
      _client: unknown,
      _options: { channel: string; thread_ts?: string; text: string },
    ) => ({ ok: true }),
  ),
}));

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: slackMessagingMocks.safePostMessage,
}));

vi.mock("@slack/web-api", () => ({
  WebClient: class {},
}));

import {
  TURN_SOFT_DEADLINE_MS,
  TURN_HARD_DEADLINE_MS,
  MAX_CONTINUATION_DEPTH,
  CONTINUATION_DEPTH_EXCEEDED_MESSAGE,
  TRUNCATED_MESSAGE_MAX_CHARS,
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
    expect(row.description).toMatch(/^\[CONTINUE:turn-deadline-abcd1234:d1\] /);
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

  it("appends the truncated message verbatim to the description (issue #1336)", async () => {
    const truncatedMessage =
      "Here are rows 1-40 as promised.\n\n" +
      "Remaining: rows 41-100, plus the corrected Smart View recipe.";

    const ok = await spawnTurnContinuationJob({
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      elapsedMs: 723_456,
      step: 41,
      truncatedMessage,
    });

    expect(ok).toBe(true);
    const description = dbMock.insertValues[0].description as string;
    expect(description).toContain(
      `Your previous message ended here before being cut off:\n"""\n${truncatedMessage}\n"""`,
    );
    expect(description).toContain(
      "Anything you stated as remaining or promised for later in that text is still owed",
    );
    expect(description).toContain(
      "treat it as a checklist and deliver ALL of it",
    );
    // The generic boilerplate is preserved in front of the appended message.
    expect(description).toMatch(/^\[CONTINUE:turn-deadline-/);
    expect(description).toContain("complete the remaining work and post the results in the same thread.");
  });

  it("keeps only the tail of a very long truncated message", async () => {
    const tail = "END-OF-MESSAGE: remaining items are X, Y and Z.";
    const truncatedMessage = "a".repeat(TRUNCATED_MESSAGE_MAX_CHARS * 3) + tail;

    await spawnTurnContinuationJob({
      channelId: "C0123456",
      elapsedMs: 720_000,
      step: 12,
      truncatedMessage,
    });

    const description = dbMock.insertValues[0].description as string;
    expect(description).toContain(tail);
    expect(description).not.toContain(truncatedMessage);
    const quoted = description.split('"""')[1];
    expect(quoted.trim().length).toBe(TRUNCATED_MESSAGE_MAX_CHARS);
  });

  it("omits the cut-off framing when truncatedMessage is absent or blank (backward compatible)", async () => {
    await spawnTurnContinuationJob({
      channelId: "C0123456",
      elapsedMs: 720_000,
      step: 12,
    });
    await spawnTurnContinuationJob({
      channelId: "C0123456",
      elapsedMs: 720_000,
      step: 12,
      truncatedMessage: "   \n  ",
    });

    expect(dbMock.insertValues).toHaveLength(2);
    for (const row of dbMock.insertValues) {
      const description = row.description as string;
      expect(description).not.toContain("ended here before being cut off");
      expect(description).not.toContain('"""');
      // Exactly the pre-#1336 description shape.
      expect(description).toMatch(
        /^\[CONTINUE:turn-deadline-[^\]]+\] The previous turn in Slack channel C0123456 hit its wall-clock budget after 720s \(step 12\) and was stopped before finishing\. Read the recent messages in that thread to see what was requested and what was already done, then complete the remaining work and post the results in the same thread\.$/,
      );
    }
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

describe("spawnTurnContinuationJob depth cap (issue #1320)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.insertError = null;
    dbMock.insertValues = [];
  });

  it("encodes the requested depth in the [CONTINUE:topic:dN] tag", async () => {
    const ok = await spawnTurnContinuationJob({
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      invocationId: "abcd1234-5678-90ab-cdef-000000000000",
      elapsedMs: 720_000,
      step: 12,
      depth: 2,
    });

    expect(ok).toBe(true);
    expect(dbMock.insertValues[0].description).toMatch(
      /^\[CONTINUE:turn-deadline-abcd1234:d2\] /,
    );
  });

  it("still spawns at exactly the max depth", async () => {
    const ok = await spawnTurnContinuationJob({
      channelId: "C0123456",
      elapsedMs: 720_000,
      step: 12,
      depth: MAX_CONTINUATION_DEPTH,
    });

    expect(ok).toBe(true);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.insertValues[0].description).toContain(`:d${MAX_CONTINUATION_DEPTH}]`);
    expect(errorLoggerMocks.logError).not.toHaveBeenCalled();
    expect(slackMessagingMocks.safePostMessage).not.toHaveBeenCalled();
  });

  it("refuses past the cap: no job, thread notified, error event logged", async () => {
    const ok = await spawnTurnContinuationJob({
      channelId: "C0123456",
      threadTs: "1755500000.000100",
      userId: "U0999",
      invocationId: "abcd1234-5678-90ab-cdef-000000000000",
      elapsedMs: 723_456,
      step: 41,
      depth: MAX_CONTINUATION_DEPTH + 1,
    });

    expect(ok).toBe(false);
    expect(dbMock.insert).not.toHaveBeenCalled();

    expect(errorLoggerMocks.logError).toHaveBeenCalledTimes(1);
    expect(errorLoggerMocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: "TurnContinuationDepthExceeded",
        errorCode: "turn_continuation_depth_exceeded",
        channelId: "C0123456",
        userId: "U0999",
        context: expect.objectContaining({
          depth: MAX_CONTINUATION_DEPTH + 1,
          maxDepth: MAX_CONTINUATION_DEPTH,
          threadTs: "1755500000.000100",
        }),
      }),
    );

    expect(slackMessagingMocks.safePostMessage).toHaveBeenCalledTimes(1);
    const [, postArgs] = slackMessagingMocks.safePostMessage.mock.calls[0];
    expect(postArgs.channel).toBe("C0123456");
    expect(postArgs.thread_ts).toBe("1755500000.000100");
    expect(postArgs.text).toContain("<@U0999>");
    expect(postArgs.text).toContain(CONTINUATION_DEPTH_EXCEEDED_MESSAGE);
  });

  it("skips the Slack post (but still logs) when no channel is known", async () => {
    const ok = await spawnTurnContinuationJob({
      elapsedMs: 720_000,
      step: 12,
      depth: MAX_CONTINUATION_DEPTH + 1,
    });

    expect(ok).toBe(false);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(errorLoggerMocks.logError).toHaveBeenCalledTimes(1);
    expect(slackMessagingMocks.safePostMessage).not.toHaveBeenCalled();
  });

  it("is fail-soft when the depth-cap Slack post throws", async () => {
    slackMessagingMocks.safePostMessage.mockRejectedValueOnce(new Error("slack down"));

    const ok = await spawnTurnContinuationJob({
      channelId: "C0123456",
      elapsedMs: 720_000,
      step: 12,
      depth: MAX_CONTINUATION_DEPTH + 1,
    });

    expect(ok).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "turn-deadline: failed to notify thread about depth cap",
      expect.objectContaining({ error: "slack down" }),
    );
  });
});
