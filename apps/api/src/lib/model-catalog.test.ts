import { describe, expect, it, vi } from "vitest";

/**
 * Fixture rows in query order (provider asc, name asc). Shape mirrors the
 * select in getModelCatalogResponse (no selections join).
 */
const rows = [
  {
    modelId: "anthropic/claude-x",
    name: "Claude X",
    provider: "anthropic",
    type: "language",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
  },
  {
    modelId: "bfl/flux-pro",
    name: "FLUX Pro",
    provider: "bfl",
    type: "image",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
  },
  {
    modelId: "cohere/rerank-v3",
    name: "Rerank v3",
    provider: "cohere",
    type: "reranking",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
  },
  {
    modelId: "google/gemini-y",
    name: "Gemini Y",
    provider: "google",
    type: "language",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
  },
  {
    modelId: "klingai/kling-t2v",
    name: "Kling T2V",
    provider: "klingai",
    type: "video",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
  },
  {
    modelId: "mystery/model",
    name: "Mystery Model",
    provider: "mystery",
    type: "unknown",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
  },
  {
    modelId: "voyage/voyage-3",
    name: "Voyage 3",
    provider: "voyage",
    type: "embedding",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
  },
];

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { getModelCatalogResponse } = await import("./model-catalog.js");

describe("getModelCatalogResponse", () => {
  it("lists the full catalog per category, filtered only by type metadata", async () => {
    const response = await getModelCatalogResponse();

    // Chat categories: language + unknown-type models; image/video/embedding/
    // reranking excluded.
    const expectedChat = ["anthropic/claude-x", "google/gemini-y", "mystery/model"];
    expect(response.main.map((o) => o.value)).toEqual(expectedChat);
    expect(response.fast.map((o) => o.value)).toEqual(expectedChat);
    expect(response.medium.map((o) => o.value)).toEqual(expectedChat);
    expect(response.escalation.map((o) => o.value)).toEqual(expectedChat);

    // Embedding category: embedding models plus unknown-type ones.
    expect(response.embedding.map((o) => o.value)).toEqual([
      "mystery/model",
      "voyage/voyage-3",
    ]);

    // Full catalog is always present.
    expect(response.catalog).toHaveLength(rows.length);

    // defaults is always empty — active models are driven by the settings table.
    expect(response.defaults).toEqual({});
  });

  it("excludes image, video, and reranking models from all categories", async () => {
    const response = await getModelCatalogResponse();
    const allModelIds = [
      ...response.main,
      ...response.fast,
      ...response.medium,
      ...response.escalation,
      ...response.embedding,
    ].map((o) => o.value);

    expect(allModelIds).not.toContain("bfl/flux-pro");
    expect(allModelIds).not.toContain("cohere/rerank-v3");
    expect(allModelIds).not.toContain("klingai/kling-t2v");
  });
});
