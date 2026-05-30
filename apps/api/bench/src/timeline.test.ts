process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchCase } from "./types.js";

const state = vi.hoisted(() => ({
  lateExtractionFinished: false,
  lateExtractionResolve: null as (() => void) | null,
}));

vi.mock("../../src/db/client.js", () => ({ db: {} }));
vi.mock("../../src/lib/embeddings.js", () => ({ embedTexts: vi.fn() }));

vi.mock("../../src/memory/extract.js", () => ({
  extractMemoriesFromTranscript: vi.fn(async (_messages: unknown, ctx: any) => {
    if (ctx.benchProvenance?.caseId !== "late") return;
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
    vi.clearAllMocks();
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
