import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const aiMocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  rerank: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    execute: dbMocks.execute,
  },
}));

vi.mock("../lib/embeddings.js", () => ({
  embedText: vi.fn(async () => Array.from({ length: 1536 }, () => 0.001)),
}));

vi.mock("../lib/ai.js", () => ({
  getFastModel: vi.fn(async () => ({ id: "fast-test-model" })),
  getRerankingModel: vi.fn(async () => null),
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
  generateObject: aiMocks.generateObject,
  rerank: aiMocks.rerank,
}));

import { retrieveMemories, fuseCandidates } from "./retrieve.js";
import type { Memory } from "@aura/db/schema";

interface RenderedQuery {
  sql: string;
  params: unknown[];
}

function renderSql(query: any): RenderedQuery {
  if (!query?.toQuery) return { sql: String(query), params: [] };
  const rendered = query.toQuery({
    escapeName: (name: string) => `"${name}"`,
    escapeParam: (index: number) => `$${index + 1}`,
    escapeString: (value: string) => `'${value.replace(/'/g, "''")}'`,
  });
  return { sql: rendered.sql, params: rendered.params };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function setupDb(options: { resolveEntity?: boolean } = {}) {
  const executed: RenderedQuery[] = [];
  const resolveEntity = options.resolveEntity ?? false;

  dbMocks.execute.mockImplementation(async (query: any) => {
    const rendered = renderSql(query);
    executed.push(rendered);
    const compact = normalizeSql(rendered.sql);

    if (compact.includes("FROM unnest(to_tsvector")) {
      return { rows: [] };
    }

    if (
      resolveEntity &&
      compact.includes("FROM entities") &&
      compact.includes("lower(canonical_name)") &&
      compact.includes("LIMIT 1")
    ) {
      return {
        rows: [{ id: "entity-vadim", canonical_name: "Vadim", type: "person" }],
      };
    }

    if (compact.includes("SELECT DISTINCT m.*") && compact.includes("JOIN memory_entities me")) {
      return { rows: [] };
    }

    if (compact.startsWith("WITH ")) {
      return { rows: [] };
    }

    return { rows: [] };
  });

  return executed;
}

function hybridQuery(executed: RenderedQuery[]): RenderedQuery {
  const query = executed.find((entry) => normalizeSql(entry.sql).startsWith("WITH "));
  expect(query).toBeDefined();
  return query!;
}

describe("retrieveMemories prefilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.generateObject.mockResolvedValue({ object: { entities: [] } });
  });

  it("restricts scored candidates to resolved entity memories plus the recent tail", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: { entities: [{ name: "Vadim", type: "person" }] },
    });
    const executed = setupDb({ resolveEntity: true });

    await retrieveMemories({
      query: "What did Vadim decide?",
      currentUserId: "U123",
      channelId: "C123",
      channelType: "public_channel",
      workspaceId: "W123",
      limit: 15,
    });

    const rendered = hybridQuery(executed);
    const compact = normalizeSql(rendered.sql);
    expect(compact).toContain("candidate_pool AS");
    expect(compact).toContain("FROM memory_entities me JOIN memories m ON m.id = me.memory_id");
    expect(compact).toContain("WHERE me.entity_id IN");
    expect(compact).toContain("ORDER BY created_at DESC");
    expect(compact).toContain("id IN (SELECT id FROM candidate_pool)");
    expect(rendered.params).toContain("entity-vadim");
    expect(rendered.params).toContain(50);
  });

  it("keeps the legacy global candidate pool when no entity resolves", async () => {
    const executed = setupDb({ resolveEntity: false });

    await retrieveMemories({
      query: "what was decided recently",
      currentUserId: "U123",
      channelId: "C123",
      channelType: "public_channel",
      workspaceId: "W123",
      limit: 15,
    });

    const compact = normalizeSql(hybridQuery(executed).sql);
    expect(compact).not.toContain("candidate_pool AS");
    expect(compact).not.toContain("id IN (SELECT id FROM candidate_pool)");
  });

  it("guards DM-private memories to the current DM channel", async () => {
    const executed = setupDb({ resolveEntity: false });

    await retrieveMemories({
      query: "what do you remember",
      currentUserId: "U_B",
      channelId: "D2",
      channelType: "dm",
      workspaceId: "W123",
      limit: 15,
    });

    const rendered = hybridQuery(executed);
    const compact = normalizeSql(rendered.sql);
    expect(compact).toContain("source_channel_type != 'dm'");
    expect(compact).toContain("source_channel_type = 'dm' AND source_channel_id =");
    expect(compact).toContain("related_user_ids @> ARRAY");
    expect(rendered.params).toContain("D2");
    expect(rendered.params).toContain("U_B");
    expect(rendered.params).not.toContain("D1");
    expect(rendered.params).not.toContain("U_A");
  });

  it("does not add the entity candidate pool when prefilter is disabled", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: { entities: [{ name: "Vadim", type: "person" }] },
    });
    const executed = setupDb({ resolveEntity: true });

    await retrieveMemories({
      query: "What did Vadim decide?",
      currentUserId: "U123",
      channelId: "C123",
      channelType: "public_channel",
      workspaceId: "W123",
      prefilter: false,
      limit: 15,
    });

    const compact = normalizeSql(hybridQuery(executed).sql);
    expect(compact).not.toContain("candidate_pool AS");
    expect(compact).not.toContain("id IN (SELECT id FROM candidate_pool)");
  });
});

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
    signals: { similarity?: number; bm25?: number; entityBoost?: number; channelBoost?: number; linkedMemoryIds?: string[]; createdAt?: Date },
  ) {
    return {
      memory: mem(id, {
        linkedMemoryIds: signals.linkedMemoryIds ?? [],
        createdAt: signals.createdAt ?? new Date(NOW),
      }),
      similarity: signals.similarity ?? 0,
      bm25: signals.bm25 ?? 0,
      entityBoost: signals.entityBoost ?? 0,
      channelBoost: signals.channelBoost ?? 0,
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

  it("applies a graph-expansion boost to memories linked from a top anchor (multi-hop)", () => {
    // `operandB` has no direct semantic/lexical signal, but the top anchor
    // links to it — fusion should lift it above an unrelated weak candidate.
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
    // override flips the semantic ordering relative to raw cosine.
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
