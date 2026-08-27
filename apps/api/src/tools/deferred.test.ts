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
      // Mirrors the real provider-executed tool shape: `type: "provider"` +
      // an `anthropic.` tool id (the server-tool marker).
      toolSearchBm25_20251119: vi.fn(() => ({
        type: "provider",
        id: "anthropic.tool_search_bm25_20251119",
        args: {},
      })),
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
  hasAnthropicServerSideTools,
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

describe("hasAnthropicServerSideTools (issue #1357)", () => {
  beforeEach(() => {
    dbMocks.rows = [];
  });

  it("returns true after applyAnthropicToolDiscovery on an anthropic model", async () => {
    const tools: Record<string, any> = {
      send_voice_note: { description: "Generate a voice note." },
    };

    expect(hasAnthropicServerSideTools(tools)).toBe(false);

    await applyAnthropicToolDiscovery(
      tools,
      "anthropic/claude-opus-4.5",
      { channelId: "C123", threadTs: "171234.000100" },
    );

    expect(hasAnthropicServerSideTools(tools)).toBe(true);
  });

  it("returns false for a non-anthropic model (no server tool injected)", async () => {
    const tools: Record<string, any> = {
      send_voice_note: { description: "Generate a voice note." },
    };

    await applyAnthropicToolDiscovery(
      tools,
      "openai/gpt-5.1",
      { channelId: "C123", threadTs: "171234.000100" },
    );

    expect(tools.toolSearch).toBeUndefined();
    expect(hasAnthropicServerSideTools(tools)).toBe(false);
  });

  it("detects the server-tool marker, not the toolSearch key name", () => {
    expect(
      hasAnthropicServerSideTools({
        renamed: { type: "provider", id: "anthropic.tool_search_bm25_20251119" },
      }),
    ).toBe(true);
    // A regular function tool that happens to be named toolSearch is NOT a
    // server-side tool.
    expect(
      hasAnthropicServerSideTools({
        toolSearch: { description: "regular tool", inputSchema: {} },
      }),
    ).toBe(false);
    expect(hasAnthropicServerSideTools(undefined)).toBe(false);
    expect(hasAnthropicServerSideTools({})).toBe(false);
  });
});
