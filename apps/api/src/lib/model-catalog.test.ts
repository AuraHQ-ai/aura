import { describe, expect, it, vi } from "vitest";

/**
 * Fixture rows in query order (provider asc, name asc). Shape mirrors the
 * select in getModelCatalogResponse.
 */
const rows = [
  {
    modelId: "anthropic/claude-x",
    name: "Claude X",
    provider: "anthropic",
    type: "language",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    selectionCategory: "main",
    selectionEnabled: true,
    selectionDefault: true,
  },
  {
    modelId: "bfl/flux-pro",
    name: "FLUX Pro",
    provider: "bfl",
    type: "image",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    selectionCategory: null,
    selectionEnabled: null,
    selectionDefault: null,
  },
  {
    modelId: "cohere/rerank-v3",
    name: "Rerank v3",
    provider: "cohere",
    type: "reranking",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    selectionCategory: null,
    selectionEnabled: null,
    selectionDefault: null,
  },
  {
    modelId: "google/gemini-y",
    name: "Gemini Y",
    provider: "google",
    type: "language",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    selectionCategory: null,
    selectionEnabled: null,
    selectionDefault: null,
  },
  {
    modelId: "klingai/kling-t2v",
    name: "Kling T2V",
    provider: "klingai",
    type: "video",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    selectionCategory: null,
    selectionEnabled: null,
    selectionDefault: null,
  },
  {
    modelId: "mystery/model",
    name: "Mystery Model",
    provider: "mystery",
    type: "unknown",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    selectionCategory: null,
    selectionEnabled: null,
    selectionDefault: null,
  },
  {
    modelId: "voyage/voyage-3",
    name: "Voyage 3",
    provider: "voyage",
    type: "embedding",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    selectionCategory: "embedding",
    selectionEnabled: true,
    selectionDefault: true,
  },
];

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { getModelCatalogResponse } = await import("./model-catalog.js");

describe("getModelCatalogResponse (curated lists, default)", () => {
  it("lists only enabled selections per category (plus the no-selection fallback) and takes defaults from isDefault rows", async () => {
    const response = await getModelCatalogResponse();

    expect(response.main.map((o) => o.value)).toContain("anthropic/claude-x");
    expect(response.embedding.map((o) => o.value)).toEqual(["voyage/voyage-3"]);
    // No enabled selections for these categories → empty curated lists.
    expect(response.fast).toEqual([]);
    expect(response.medium).toEqual([]);
    expect(response.escalation).toEqual([]);

    expect(response.defaults.main).toBe("anthropic/claude-x");
    expect(response.defaults.embedding).toBe("voyage/voyage-3");

    // Full catalog is always present alongside the curated lists.
    expect(response.catalog).toHaveLength(rows.length);
  });
});

describe("getModelCatalogResponse (fullCategoryLists)", () => {
  it("lists the full catalog per category, filtered only by type metadata", async () => {
    const response = await getModelCatalogResponse(undefined, {
      fullCategoryLists: true,
    });

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
  });

  it("keeps defaults selections-driven, not first-of-full-list", async () => {
    const response = await getModelCatalogResponse(undefined, {
      fullCategoryLists: true,
    });

    expect(response.defaults.main).toBe("anthropic/claude-x");
    expect(response.defaults.embedding).toBe("voyage/voyage-3");
    // No selection rows for fast → no invented default from the full list.
    expect(response.defaults.fast).toBeUndefined();
  });
});
