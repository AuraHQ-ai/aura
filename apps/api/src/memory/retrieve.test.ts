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

import { hasRetrievalEvidence } from "./retrieve.js";

describe("hasRetrievalEvidence (#1045 abstention gate)", () => {
  it("treats a resolved entity as evidence regardless of similarity", () => {
    expect(hasRetrievalEvidence([{ similarity: 0, bm25: 0 }], 1)).toBe(true);
  });

  it("treats a strong cosine match as evidence", () => {
    expect(hasRetrievalEvidence([{ similarity: 0.42, bm25: 0 }], 0)).toBe(true);
  });

  it("treats any lexical BM25 hit as evidence", () => {
    expect(hasRetrievalEvidence([{ similarity: 0.1, bm25: 0.05 }], 0)).toBe(true);
  });

  it("abstains when all signals are weak", () => {
    expect(
      hasRetrievalEvidence(
        [
          { similarity: 0.2, bm25: 0 },
          { similarity: 0.15, bm25: 0 },
        ],
        0,
      ),
    ).toBe(false);
  });

  it("abstains on an empty candidate set", () => {
    expect(hasRetrievalEvidence([], 0)).toBe(false);
  });
});
