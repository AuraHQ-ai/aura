import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    insertedRows: [] as Record<string, unknown>[],
    select: vi.fn(),
    insert: vi.fn(),
  };

  function nextResult() {
    return state.results.shift() ?? [];
  }

  function createSelect() {
    const query: any = {
      from: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      leftJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      groupBy: vi.fn(() => query),
      having: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(nextResult()).then(onFulfilled, onRejected),
    };
    return query;
  }

  function createInsert() {
    const query: any = {
      values: vi.fn((rows: Record<string, unknown>[]) => {
        state.insertedRows.push(...rows);
        return query;
      }),
      onConflictDoNothing: vi.fn(() => Promise.resolve()),
    };
    return query;
  }

  state.select.mockImplementation(createSelect);
  state.insert.mockImplementation(createInsert);
  return state;
});

const judgeWindowMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: { select: dbMock.select, insert: dbMock.insert },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../eval/judge.js", () => ({
  judgeWindow: judgeWindowMock,
}));

import { scoreGroup } from "./eval-responses.js";

function traceRow(id: string, minute: number) {
  return {
    id,
    workspaceId: "default",
    sourceType: "interactive",
    source: "slack",
    jobExecutionId: null,
    channelId: "C123",
    threadTs: "1700000000.000100",
    userId: "U123",
    modelId: null,
    resolvedModelId: null,
    tokenUsage: null,
    costUsd: null,
    costPricedAt: null,
    createdAt: new Date(Date.UTC(2026, 2, 12, 10, minute)),
  };
}

function messageRow(id: string, conversationId: string, role: string, orderIndex: number, content: string | null = null) {
  return { id, conversationId, role, content, orderIndex, createdAt: new Date() };
}

function fulfilledVerdict(partId: string) {
  return {
    partId,
    scorable: true,
    verdict: "fulfilled" as const,
    failureClass: "none" as const,
    servingIntent: `intent ${partId}`,
    resolvedInWindow: false,
    note: null,
  };
}

beforeEach(() => {
  dbMock.results = [];
  dbMock.insertedRows = [];
  judgeWindowMock.mockReset();
});

const GROUP = {
  channelId: "C123",
  threadTs: "1700000000.000100",
  soleTraceId: "t1",
  firstAt: new Date(),
};

describe("scoreGroup", () => {
  it("judges unscored responses and persists rows on the correct grains", async () => {
    dbMock.results = [
      // traces
      [traceRow("t1", 0)],
      // messages
      [
        messageRow("u1", "t1", "user", 1, "do the thing"),
        messageRow("a1", "t1", "assistant", 2),
      ],
      // parts
      [
        { id: "pt-a1", messageId: "a1", type: "text", orderIndex: 0, textValue: "done", toolName: null },
      ],
      // already-scored rows
      [],
    ];
    judgeWindowMock.mockResolvedValue({
      judged: new Map([["pt-a1", fulfilledVerdict("pt-a1")]]),
      judgeModel: "judge-model",
      unknownIds: [],
      omittedIds: [],
    });

    const result = await scoreGroup(GROUP, Date.now() + 60_000);

    expect(result).toEqual({ windowsJudged: 1, responsesScored: 1, omitted: 0 });
    expect(dbMock.insertedRows).toHaveLength(1);
    expect(dbMock.insertedRows[0]).toMatchObject({
      workspaceId: "default",
      messageId: "a1",
      partId: "pt-a1",
      traceId: "t1",
      threadTs: "1700000000.000100",
      verdict: "fulfilled",
      scorable: true,
      failureClass: "none",
      judgeModel: "judge-model",
    });
  });

  it("excludes already-scored responses from scoring targets (idempotency)", async () => {
    dbMock.results = [
      [traceRow("t1", 0)],
      [
        messageRow("u1", "t1", "user", 1, "first ask"),
        messageRow("a1", "t1", "assistant", 2),
        messageRow("u2", "t1", "user", 3, "second ask"),
        messageRow("a2", "t1", "assistant", 4),
      ],
      [
        { id: "pt-a1", messageId: "a1", type: "text", orderIndex: 0, textValue: "first answer", toolName: null },
        { id: "pt-a2", messageId: "a2", type: "text", orderIndex: 0, textValue: "second answer", toolName: null },
      ],
      // a1 already has a verdict
      [{ messageId: "a1" }],
    ];
    judgeWindowMock.mockImplementation(async (window: { ownedPartIds: string[] }) => ({
      judged: new Map(window.ownedPartIds.map((id: string) => [id, fulfilledVerdict(id)])),
      judgeModel: "judge-model",
      unknownIds: [],
      omittedIds: [],
    }));

    const result = await scoreGroup(GROUP, Date.now() + 60_000);

    expect(judgeWindowMock).toHaveBeenCalledTimes(1);
    const windowArg = judgeWindowMock.mock.calls[0][0];
    // Only the unscored response is owned; the scored one stays as context.
    expect(windowArg.ownedPartIds).toEqual(["pt-a2"]);
    expect(windowArg.turns).toHaveLength(4);

    expect(result.responsesScored).toBe(1);
    expect(dbMock.insertedRows.map((r) => r.messageId)).toEqual(["a2"]);
  });

  it("skips the judge entirely when every response is already scored", async () => {
    dbMock.results = [
      [traceRow("t1", 0)],
      [
        messageRow("u1", "t1", "user", 1, "ask"),
        messageRow("a1", "t1", "assistant", 2),
      ],
      [
        { id: "pt-a1", messageId: "a1", type: "text", orderIndex: 0, textValue: "answer", toolName: null },
      ],
      [{ messageId: "a1" }],
    ];

    const result = await scoreGroup(GROUP, Date.now() + 60_000);

    expect(judgeWindowMock).not.toHaveBeenCalled();
    expect(result).toEqual({ windowsJudged: 0, responsesScored: 0, omitted: 0 });
    expect(dbMock.insertedRows).toHaveLength(0);
  });

  it("stops judging when the deadline has passed", async () => {
    dbMock.results = [
      [traceRow("t1", 0)],
      [
        messageRow("u1", "t1", "user", 1, "ask"),
        messageRow("a1", "t1", "assistant", 2),
      ],
      [
        { id: "pt-a1", messageId: "a1", type: "text", orderIndex: 0, textValue: "answer", toolName: null },
      ],
      [],
    ];

    const result = await scoreGroup(GROUP, Date.now() - 1);

    expect(judgeWindowMock).not.toHaveBeenCalled();
    expect(result.responsesScored).toBe(0);
  });
});
