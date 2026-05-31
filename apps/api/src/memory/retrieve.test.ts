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

import {
  retrieveMemories,
  decideEntityPrefilter,
} from "./retrieve.js";

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

function memoryRow(id: string) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    workspace_id: "W123",
    content: `memory ${id}`,
    type: "fact",
    source_message_id: null,
    source_channel_type: "public_channel",
    source_thread_ts: null,
    source_channel_id: "C123",
    related_user_ids: [],
    embedding: null,
    relevance_score: 0.8,
    shareable: 0,
    search_vector: null,
    status: "current",
    confidence: 0.8,
    valid_from: null,
    valid_until: null,
    supersedes_memory_id: null,
    superseded_at: null,
    superseded_by_memory_id: null,
    created_at: now,
    updated_at: now,
  };
}

function setupDb(options: { resolveEntity?: boolean; entityMemoryCount?: number } = {}) {
  const executed: RenderedQuery[] = [];
  const resolveEntity = options.resolveEntity ?? false;
  const entityMemoryCount = options.entityMemoryCount ?? 0;

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
      return {
        rows: Array.from({ length: entityMemoryCount }, (_, index) =>
          memoryRow(`entity-memory-${index}`),
        ),
      };
    }

    if (compact.includes("SELECT me.memory_id, me.entity_id")) {
      return {
        rows: Array.from({ length: entityMemoryCount }, (_, index) => ({
          memory_id: `entity-memory-${index}`,
          entity_id: "entity-vadim",
        })),
      };
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
    const executed = setupDb({ resolveEntity: true, entityMemoryCount: 15 });

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
    expect(compact).toContain("global_cosine_candidates AS");
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

  it("falls back to the global pool when resolved entities return too few memories", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: { entities: [{ name: "Vadim", type: "person" }] },
    });
    const executed = setupDb({ resolveEntity: true, entityMemoryCount: 1 });

    await retrieveMemories({
      query: "What did Vadim decide?",
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
    const executed = setupDb({ resolveEntity: true, entityMemoryCount: 15 });

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

describe("decideEntityPrefilter", () => {
  it("requires high-confidence, top-k-sized entity candidates", () => {
    expect(
      decideEntityPrefilter({
        enabled: true,
        resolvedEntityCount: 0,
        entityMemoryCount: 0,
        usedHeuristic: false,
        resolutionConfidences: [],
        limit: 15,
      }),
    ).toMatchObject({ apply: false, reason: "no-resolved-entities" });

    expect(
      decideEntityPrefilter({
        enabled: true,
        resolvedEntityCount: 1,
        entityMemoryCount: 50,
        usedHeuristic: false,
        resolutionConfidences: ["fuzzy"],
        limit: 15,
      }),
    ).toMatchObject({ apply: false, reason: "low-confidence-resolution" });

    expect(
      decideEntityPrefilter({
        enabled: true,
        resolvedEntityCount: 1,
        entityMemoryCount: 14,
        usedHeuristic: false,
        resolutionConfidences: ["exact"],
        limit: 15,
      }),
    ).toMatchObject({ apply: false, reason: "sparse-entity-candidates" });

    expect(
      decideEntityPrefilter({
        enabled: true,
        resolvedEntityCount: 1,
        entityMemoryCount: 15,
        usedHeuristic: false,
        resolutionConfidences: ["alias"],
        limit: 15,
      }),
    ).toMatchObject({ apply: true, reason: "applied" });
  });
});
