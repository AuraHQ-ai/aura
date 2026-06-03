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

import {
  hasRetrievalEvidence,
  isMemoryVisibleToParticipant,
  looksMultiHop,
  mergeRoundRobin,
} from "./retrieve.js";
import type { Memory } from "@aura/db/schema";

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

describe("query planning helpers (#276 / #1056)", () => {
  it("looksMultiHop flags conjunctions, comparisons, and multi-question queries", () => {
    expect(looksMultiHop("who manages the project Alice and Bob started?")).toBe(true);
    expect(looksMultiHop("compare the Q3 and Q4 churn numbers")).toBe(true);
    expect(looksMultiHop("what's the budget? who approved it?")).toBe(true);
  });

  it("looksMultiHop leaves simple single-fact queries alone", () => {
    expect(looksMultiHop("what did Vadim decide about churn")).toBe(false);
    expect(looksMultiHop("when is the offsite")).toBe(false);
  });

  it("mergeRoundRobin interleaves lists, dedupes, and respects the limit", () => {
    const m = (id: string) => ({ id }) as Memory;
    const merged = mergeRoundRobin(
      [
        [m("a1"), m("a2"), m("a3")],
        [m("b1"), m("a2"), m("b2")],
      ],
      4,
    );
    expect(merged.map((x) => x.id)).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("mergeRoundRobin gives every list representation", () => {
    const m = (id: string) => ({ id }) as Memory;
    const merged = mergeRoundRobin(
      [[m("a1"), m("a2")], [m("b1"), m("b2")], [m("c1")]],
      3,
    );
    expect(merged.map((x) => x.id)).toEqual(["a1", "b1", "c1"]);
  });
});

describe("participant-scoped memory visibility", () => {
  it("keeps MPIM memories visible only to participants unless shareable", () => {
    expect(
      isMemoryVisibleToParticipant({
        sourceChannelType: "mpim",
        shareable: 0,
        relatedUserIds: ["U_participant"],
        currentUserId: "U_participant",
      }),
    ).toBe(true);

    expect(
      isMemoryVisibleToParticipant({
        sourceChannelType: "mpim",
        shareable: 0,
        relatedUserIds: ["U_participant"],
        currentUserId: "U_outsider",
      }),
    ).toBe(false);

    expect(
      isMemoryVisibleToParticipant({
        sourceChannelType: "mpim",
        shareable: 1,
        relatedUserIds: [],
        currentUserId: "U_outsider",
      }),
    ).toBe(true);
  });

  it("applies the same participant scope to DMs but not workspace channels", () => {
    expect(
      isMemoryVisibleToParticipant({
        sourceChannelType: "dm",
        shareable: 0,
        relatedUserIds: ["U_other"],
        currentUserId: "U_current",
      }),
    ).toBe(false);

    expect(
      isMemoryVisibleToParticipant({
        sourceChannelType: "public_channel",
        shareable: 0,
        relatedUserIds: [],
        currentUserId: "U_current",
      }),
    ).toBe(true);
  });
});
