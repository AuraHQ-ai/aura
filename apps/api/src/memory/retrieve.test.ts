import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    execute: vi.fn(),
  },
}));

vi.mock("../lib/embeddings.js", () => ({
  embedText: vi.fn(),
}));

vi.mock("../lib/ai.js", () => ({
  getFastModel: vi.fn(),
  getRerankingModel: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("ai", () => ({
  generateObject: vi.fn(),
  rerank: vi.fn(),
}));

import { fuseCandidates } from "./retrieve.js";
import type { Memory } from "@aura/db/schema";

describe("fuseCandidates (#1054 score fusion)", () => {
  const NOW = Date.UTC(2026, 0, 1);

  function mem(id: string, over: Partial<Memory> = {}): Memory {
    return {
      id,
      content: `memory ${id}`,
      relevanceScore: 0.5,
      linkedMemoryIds: [],
      createdAt: new Date(NOW),
      sourceChannelId: null,
      ...over,
    } as unknown as Memory;
  }

  function candidate(
    id: string,
    signals: {
      similarity?: number;
      bm25?: number;
      entityBoost?: number;
      linkedMemoryIds?: string[];
      createdAt?: Date;
    },
  ) {
    return {
      memory: mem(id, {
        linkedMemoryIds: signals.linkedMemoryIds ?? [],
        createdAt: signals.createdAt ?? new Date(NOW),
      }),
      similarity: signals.similarity ?? 0,
      bm25: signals.bm25 ?? 0,
      entityBoost: signals.entityBoost ?? 0,
    };
  }

  it("ranks the strongest semantic + lexical candidate first", () => {
    const out = fuseCandidates(
      [
        candidate("weak", { similarity: 0.1, bm25: 0 }),
        candidate("strong", { similarity: 0.9, bm25: 0.3 }),
        candidate("mid", { similarity: 0.5, bm25: 0.05 }),
      ],
      { now: NOW },
    );
    expect(out[0].memory.id).toBe("strong");
    expect(out[out.length - 1].memory.id).toBe("weak");
  });

  it("applies a graph-expansion boost to memories linked from a top anchor", () => {
    const ranked = fuseCandidates(
      [
        candidate("anchor", { similarity: 0.95, bm25: 0.3, linkedMemoryIds: ["operandB"] }),
        candidate("operandB", { similarity: 0.05 }),
        candidate("unrelated", { similarity: 0.05 }),
      ],
      { now: NOW },
    );
    const idx = (id: string) => ranked.findIndex((r) => r.memory.id === id);
    expect(idx("operandB")).toBeLessThan(idx("unrelated"));
  });

  it("uses the Cohere semantic override when provided", () => {
    const ranked = fuseCandidates(
      [
        candidate("a", { similarity: 0.9 }),
        candidate("b", { similarity: 0.1 }),
      ],
      { now: NOW, semanticOverride: [0.0, 1.0] },
    );
    expect(ranked[0].memory.id).toBe("b");
  });

  it("returns an empty list for no candidates", () => {
    expect(fuseCandidates([], { now: NOW })).toEqual([]);
  });
});
