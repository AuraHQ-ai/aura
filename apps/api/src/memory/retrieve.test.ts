import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrieveMocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  embedText: vi.fn(),
  getFastModel: vi.fn(),
  getRerankingModel: vi.fn(),
  generateObject: vi.fn(),
  rerank: vi.fn(),
  resolveEntityReadOnly: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    execute: retrieveMocks.dbExecute,
  },
}));

vi.mock("../lib/embeddings.js", () => ({
  embedText: retrieveMocks.embedText,
}));

vi.mock("../lib/ai.js", () => ({
  getFastModel: retrieveMocks.getFastModel,
  getRerankingModel: retrieveMocks.getRerankingModel,
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
  generateObject: retrieveMocks.generateObject,
  rerank: retrieveMocks.rerank,
}));

vi.mock("./entity-resolution.js", () => ({
  resolveEntityReadOnly: retrieveMocks.resolveEntityReadOnly,
}));

import {
  hasRetrievalEvidence,
  isMemoryVisibleToParticipant,
  looksMultiHop,
  mergeRoundRobin,
  retrieveMemories,
} from "./retrieve.js";
import type { Memory } from "@aura/db/schema";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "memory-active",
    workspace_id: "workspace-1",
    content: "Active launch incident",
    type: "event",
    source_channel_type: "public_channel",
    related_user_ids: [],
    embedding: [0.1, 0.2, 0.3],
    relevance_score: 1,
    shareable: 0,
    status: "current",
    confidence: 0.8,
    valid_from: new Date("2026-01-01T00:00:00.000Z"),
    valid_until: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    rrf_score: 0.03,
    similarity: 0.92,
    bm25: 0,
    ...overrides,
  };
}

function collectSqlText(value: unknown, seen = new Set<unknown>()): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => collectSqlText(item, seen)).join(" ");
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  if (record.name) parts.push(String(record.name));
  if (record.keyAsName) parts.push(String(record.keyAsName));
  if (record.value) parts.push(collectSqlText(record.value, seen));
  if (record.queryChunks) parts.push(collectSqlText(record.queryChunks, seen));
  return parts.join(" ");
}

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

describe("retrieveMemories temporal validity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T08:00:00.000Z"));
    retrieveMocks.dbExecute.mockReset();
    retrieveMocks.generateObject.mockReset();
    retrieveMocks.getRerankingModel.mockReset();
    retrieveMocks.resolveEntityReadOnly.mockReset();
    retrieveMocks.generateObject.mockResolvedValue({
      object: { entities: [] },
      usage: {},
    });
    retrieveMocks.getRerankingModel.mockResolvedValue(null);
    retrieveMocks.resolveEntityReadOnly.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("excludes expired current memories from the live path while keeping non-expired ones", async () => {
    const expired = row({
      id: "memory-expired",
      content: "Expired launch incident",
      valid_until: new Date("2026-06-01T00:00:00.000Z"),
      similarity: 0.95,
    });
    const active = row({
      id: "memory-active",
      content: "Active launch incident",
      valid_until: new Date("2026-06-20T00:00:00.000Z"),
      similarity: 0.9,
    });

    retrieveMocks.dbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([expired, active]);

    const result = await retrieveMemories({
      query: "launch incident",
      queryEmbedding: [0.1, 0.2, 0.3],
      currentUserId: "U_current",
      workspaceId: "workspace-1",
      adminMode: true,
      abstain: false,
    });

    expect(result.map((m) => m.id)).toEqual(["memory-active"]);

    const hybridSql = collectSqlText(retrieveMocks.dbExecute.mock.calls[1][0]).toLowerCase();
    expect(hybridSql).toContain("status");
    expect(hybridSql).toContain("current");
    expect(hybridSql).toContain("disputed");
    expect(hybridSql).toContain("valid_until");
    expect(hybridSql).toContain("now()");
  });

  it("applies the live expiration predicate to the entity-first lane", async () => {
    retrieveMocks.generateObject.mockResolvedValueOnce({
      object: { entities: [{ name: "Aura", type: "project" }] },
      usage: {},
    });
    retrieveMocks.resolveEntityReadOnly.mockResolvedValueOnce({ entityId: "entity-1" });
    retrieveMocks.dbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await retrieveMemories({
      query: "aura incident",
      queryEmbedding: [0.1, 0.2, 0.3],
      currentUserId: "U_current",
      workspaceId: "workspace-1",
      adminMode: true,
      abstain: false,
    });

    const entitySql = retrieveMocks.dbExecute.mock.calls
      .map(([query]) => collectSqlText(query).toLowerCase())
      .find((text) => text.includes("memory_entities"));

    expect(entitySql ?? "").toContain("status");
    expect(entitySql ?? "").toContain("current");
    expect(entitySql ?? "").toContain("disputed");
    expect(entitySql ?? "").toContain("valid_until");
    expect(entitySql ?? "").toContain("now()");
  });

  it("leaves the asOf replay path keyed to the requested temporal instant", async () => {
    const replayVisible = row({
      id: "memory-visible-as-of",
      valid_from: new Date("2026-01-01T00:00:00.000Z"),
      valid_until: new Date("2026-01-15T00:00:00.000Z"),
    });
    const asOf = new Date("2026-01-10T00:00:00.000Z");

    retrieveMocks.dbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([replayVisible]);

    const result = await retrieveMemories({
      query: "launch incident",
      queryEmbedding: [0.1, 0.2, 0.3],
      currentUserId: "U_current",
      workspaceId: "workspace-1",
      adminMode: true,
      abstain: false,
      asOf,
    });

    expect(result.map((m) => m.id)).toEqual(["memory-visible-as-of"]);

    const hybridSql = collectSqlText(retrieveMocks.dbExecute.mock.calls[1][0]).toLowerCase();
    expect(hybridSql).toContain("valid_from");
    expect(hybridSql).toContain("valid_until");
    expect(hybridSql).toContain(asOf.toISOString().toLowerCase());
    expect(hybridSql).not.toContain("now()");
  });
});
