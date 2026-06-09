import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  rows: [] as Array<{ toolName: string }>,
  selectedWhere: vi.fn(),
  insertValues: vi.fn(),
  onConflictDoUpdate: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: dbMocks.selectedWhere.mockImplementation(async () => dbMocks.rows),
      })),
    })),
    insert: vi.fn(() => ({
      values: dbMocks.insertValues.mockImplementation(() => ({
        onConflictDoUpdate: dbMocks.onConflictDoUpdate.mockResolvedValue(undefined),
      })),
    })),
  },
}));

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: {
    tools: {
      toolSearchBm25_20251119: vi.fn(() => ({ type: "tool-search" })),
    },
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  applyAnthropicToolDiscovery,
  cacheDeferredToolResolutions,
  getDeferredToolManifest,
} from "./deferred.js";

describe("deferred tool thread cache", () => {
  beforeEach(() => {
    dbMocks.rows = [];
    dbMocks.selectedWhere.mockClear();
    dbMocks.insertValues.mockClear();
    dbMocks.onConflictDoUpdate.mockClear();
  });

  it("defers uncached tools and includes them in the manifest", async () => {
    const tools: Record<string, any> = {
      send_voice_note: { description: "Generate a voice note." },
    };

    await applyAnthropicToolDiscovery(
      tools,
      "anthropic/claude-sonnet-4-5",
      { channelId: "C123", threadTs: "171234.000100" },
    );

    expect(tools.toolSearch).toBeDefined();
    expect(tools.send_voice_note.providerOptions.anthropic.deferLoading).toBe(true);
    expect(getDeferredToolManifest(tools)).toEqual([
      { name: "send_voice_note", description: "Generate a voice note" },
    ]);
  });

  it("injects cached deferred tools by removing deferLoading", async () => {
    dbMocks.rows = [{ toolName: "send_voice_note" }];
    const tools: Record<string, any> = {
      send_voice_note: {
        description: "Generate a voice note.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      bq_execute_query: { description: "Run SQL." },
    };

    await applyAnthropicToolDiscovery(
      tools,
      "anthropic/claude-sonnet-4-5",
      { channelId: "C123", threadTs: "171234.000100" },
    );

    expect(tools.send_voice_note.providerOptions.anthropic.deferLoading).toBeUndefined();
    expect(tools.send_voice_note.providerOptions.anthropic.cacheControl).toEqual({ type: "ephemeral" });
    expect(tools.bq_execute_query.providerOptions.anthropic.deferLoading).toBe(true);
    expect(getDeferredToolManifest(tools).map((entry) => entry.name)).toEqual(["bq_execute_query"]);
  });

  it("caches only deferred tool names for a thread", async () => {
    await cacheDeferredToolResolutions(
      { workspaceId: "W1", channelId: "C123", threadTs: "171234.000100" },
      ["send_voice_note", "not_a_deferred_tool", "send_voice_note"],
    );

    expect(dbMocks.insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        workspaceId: "W1",
        channelId: "C123",
        threadTs: "171234.000100",
        toolName: "send_voice_note",
      }),
    ]);
    expect(dbMocks.onConflictDoUpdate).toHaveBeenCalled();
  });
});
