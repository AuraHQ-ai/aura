process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchCase } from "./types.js";

const state = vi.hoisted(() => ({
  lateExtractionFinished: false,
  lateExtractionResolve: null as (() => void) | null,
  extractionCalls: [] as Array<{ messages: unknown; ctx: any }>,
  dbExecuteCount: 0,
}));

vi.mock("../../src/db/client.js", () => ({
  db: {
    execute: vi.fn(async () => {
      state.dbExecuteCount += 1;
      return [];
    }),
  },
}));
vi.mock("../../src/lib/embeddings.js", () => ({ embedTexts: vi.fn() }));

vi.mock("../../src/memory/extract.js", () => ({
  extractMemoriesFromTranscript: vi.fn(async (messages: unknown, ctx: any) => {
    state.extractionCalls.push({ messages, ctx });
    if (ctx.channelId !== "bench:late") return;
    await new Promise<void>((resolve) => {
      state.lateExtractionResolve = resolve;
    });
    state.lateExtractionFinished = true;
  }),
}));

vi.mock("./eval-retrieval.js", () => ({
  evaluateRetrieval: vi.fn(async () => ({
    retrievedMemoryIds: [],
    retrieved: [],
    coverage: null,
    coveredSessions: 0,
    evidenceSessions: 0,
    hit: null,
  })),
}));

vi.mock("./eval-qa.js", () => ({
  evaluateQA: vi.fn(async () => ({
    modelAnswer: "ok",
    judgeVerdict: "correct",
    judgeConfidence: 1,
    judgeRationale: "mocked",
    memoryTokens: 0,
    memoryChars: 0,
    memoryCount: 0,
  })),
}));

import { runTimeline } from "./timeline.js";
import { buildExtractionUnits } from "./ingest.js";

function makeCase(id: string, sessionDate: string, questionDate: string): BenchCase {
  return {
    id,
    source: "toy",
    category: "single_hop",
    question: `${id}?`,
    goldAnswer: "ok",
    abstention: false,
    questionDate,
    sessions: [
      {
        id: `${id}-session`,
        timestamp: sessionDate,
        turns: [
          { role: "user", speaker: "User", content: `${id} user` },
          { role: "assistant", speaker: "Assistant", content: `${id} assistant` },
        ],
      },
    ],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runTimeline", () => {
  beforeEach(() => {
    state.lateExtractionFinished = false;
    state.lateExtractionResolve = null;
    state.extractionCalls = [];
    state.dbExecuteCount = 0;
    vi.clearAllMocks();
  });

  it("adds a final exchange extraction for user turns after the last assistant reply", async () => {
    const benchCase: BenchCase = {
      id: "trailing",
      source: "toy",
      category: "single_hop",
      question: "What is the final fact?",
      goldAnswer: "Pepper",
      abstention: false,
      sessions: [
        {
          id: "S1",
          timestamp: "2024-09-01T10:00:00.000Z",
          turns: [
            { diaId: "S1:1", role: "user", speaker: "Alex", content: "Hello." },
            { diaId: "S1:2", role: "assistant", speaker: "Aura", content: "Tell me." },
            {
              diaId: "S1:3",
              role: "user",
              speaker: "Alex",
              content: "My dog is named Pepper.",
            },
          ],
        },
      ],
    };

    const units = buildExtractionUnits(benchCase, "bench-test", "mock-extract", "exchange");

    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.at.toISOString())).toEqual([
      "2024-09-01T10:01:00.000Z",
      "2024-09-01T10:02:00.000Z",
    ]);

    await units[1].run();

    expect(state.extractionCalls).toHaveLength(1);
    const trailing = state.extractionCalls[0].ctx;
    expect(trailing.userMessage).toBe("My dog is named Pepper.");
    expect(trailing.assistantResponse).toBe("Tell me.");
    expect(state.dbExecuteCount).toBe(1);
  });

  it("scores a question when its own conversation finishes before later conversations", async () => {
    const scored: string[] = [];
    // The early question's T_Q is after the late conversation's in-flight
    // extraction timestamp. A global-min watermark would therefore block it.
    const early = makeCase(
      "early",
      "2024-01-01T00:00:00.000Z",
      "2024-01-15T00:00:00.000Z",
    );
    const late = makeCase(
      "late",
      "2024-01-10T00:00:00.000Z",
      "2024-01-11T00:00:00.000Z",
    );

    const run = runTimeline({
      cases: [early, late],
      workspaceId: "bench-test",
      models: { extraction: "mock-extract", answerer: "mock-answerer", judge: "mock-judge" },
      replay: "exchange",
      asOf: true,
      extractConcurrency: 2,
      scoreConcurrency: 2,
      runExtraction: true,
      runScoring: true,
      doneIds: new Set(),
      priorResults: [],
      recordUsage: () => {},
      onResult: (result) => {
        scored.push(result.caseId);
      },
    });

    let waitError: unknown;
    try {
      await waitFor(() => scored.includes("early"));
      expect(state.lateExtractionResolve).not.toBeNull();
      expect(state.lateExtractionFinished).toBe(false);
      expect(scored).toEqual(["early"]);
    } catch (error) {
      waitError = error;
    } finally {
      state.lateExtractionResolve?.();
    }

    const result = await run;
    if (waitError) throw waitError;

    expect(result.cancelled).toBe(false);
    expect(scored).toEqual(["early", "late"]);
  });
});
