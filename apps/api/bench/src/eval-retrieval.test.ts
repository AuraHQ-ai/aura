process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BenchCase } from "./types.js";

const state = vi.hoisted(() => ({
  retrieved: [] as any[],
  provenanceRows: [] as any[],
}));

vi.mock("../../src/memory/retrieve.js", () => ({
  retrieveMemories: vi.fn(async () => state.retrieved),
}));

vi.mock("../../src/db/client.js", () => ({
  db: {
    execute: vi.fn(async () => state.provenanceRows),
  },
}));

import { evaluateRetrieval } from "./eval-retrieval.js";

function makeCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: "case-1",
    source: "toy",
    category: "single_hop",
    question: "What is Alex's dog's name?",
    goldAnswer: "Pepper",
    abstention: false,
    evidenceSessionIds: ["S1"],
    evidenceDiaIds: ["S1:3"],
    sessions: [],
    ...overrides,
  };
}

function makeMemory(overrides: Record<string, unknown>) {
  return {
    id: "mem-1",
    sourceThreadTs: "S1",
    benchProvenance: null,
    ...overrides,
  } as any;
}

describe("evaluateRetrieval", () => {
  beforeEach(() => {
    state.retrieved = [];
    state.provenanceRows = [];
    vi.clearAllMocks();
  });

  it("does not credit a session hit when turn-level evidence points to a different dia_id", async () => {
    state.retrieved = [makeMemory({ id: "mem-1" })];
    state.provenanceRows = [
      {
        id: "mem-1",
        source_thread_ts: "S1",
        bench_provenance: {
          sessionIds: ["S1"],
          diaIds: ["S1:1", "S1:2"],
        },
      },
    ];

    const result = await evaluateRetrieval(makeCase(), "bench-test");

    expect(result.coverage).toBe(0);
    expect(result.coveredSessions).toBe(0);
    expect(result.hit).toBe(false);
  });

  it("credits exact turn-level evidence provenance", async () => {
    state.retrieved = [makeMemory({ id: "mem-1" })];
    state.provenanceRows = [
      {
        id: "mem-1",
        source_thread_ts: "S1",
        bench_provenance: {
          sessionIds: ["S1"],
          diaIds: ["S1:1", "S1:2", "S1:3"],
        },
      },
    ];

    const result = await evaluateRetrieval(makeCase(), "bench-test");

    expect(result.coverage).toBe(1);
    expect(result.coveredSessions).toBe(1);
    expect(result.hit).toBe(true);
  });

  it("still credits session-level evidence when no dia_ids are provided", async () => {
    state.retrieved = [makeMemory({ sourceThreadTs: "S1" })];
    state.provenanceRows = [
      {
        id: "mem-1",
        source_thread_ts: "S1",
        bench_provenance: null,
      },
    ];

    const result = await evaluateRetrieval(
      makeCase({ evidenceDiaIds: [], evidenceSessionIds: ["S1"] }),
      "bench-test",
    );

    expect(result.coverage).toBe(1);
    expect(result.coveredSessions).toBe(1);
    expect(result.hit).toBe(true);
  });
});
