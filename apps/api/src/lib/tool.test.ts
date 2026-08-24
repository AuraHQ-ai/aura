import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const dbMocks = vi.hoisted(() => ({
  returning: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock("ai", () => ({
  tool: (config: any) => config,
}));

vi.mock("../db/client.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: dbMocks.returning,
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: dbMocks.updateWhere,
      })),
    })),
  },
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  defineTool,
  executionContext,
  markTurnSuspendedByDetachedCommand,
  registerToolNames,
  TOOL_CALL_AFTER_DETACHED_SUSPEND_ERROR,
} from "./tool.js";

describe("defineTool strict + inputExamples forwarding", () => {
  it("defaults strict to true when omitted", () => {
    const t = defineTool({
      description: "a tool",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ ok: true }),
    });

    // vi.mock("ai") makes tool() an identity function, so the returned
    // object is exactly the config passed to the underlying tool() call.
    expect((t as any).strict).toBe(true);
    expect((t as any).inputExamples).toBeUndefined();
  });

  it("forwards strict: false into the tool() config", () => {
    const t = defineTool({
      description: "a tool with a strict-incompatible schema",
      inputSchema: z.object({ fields: z.record(z.any()) }),
      strict: false,
      execute: async () => ({ ok: true }),
    });

    expect((t as any).strict).toBe(false);
  });

  it("forwards inputExamples unchanged into the tool() config", () => {
    const examples = [
      { input: { q: "first example" } },
      { input: { q: "second example" } },
    ];
    const t = defineTool({
      description: "a tool with examples",
      inputSchema: z.object({ q: z.string() }),
      inputExamples: examples,
      execute: async () => ({ ok: true }),
    });

    expect((t as any).inputExamples).toEqual(examples);
    expect((t as any).strict).toBe(true);
  });

  it("still injects strict when defineTool-only metadata fields are present", () => {
    const t = defineTool({
      description: "a tool",
      inputSchema: z.object({ q: z.string() }),
      slack: { status: "Working..." },
      requiredCredentials: ["some_key"],
      execute: async () => ({ ok: true }),
    });

    expect((t as any).strict).toBe(true);
    expect((t as any).__requiredCredentials).toEqual(["some_key"]);
  });
});

describe("tool detached suspend enforcement", () => {
  it("returns a hard error for tool calls after a detached command suspends the turn", async () => {
    dbMocks.returning.mockResolvedValue([{ id: "log-1" }]);
    dbMocks.updateWhere.mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools = registerToolNames({
      read_note: defineTool({
        description: "read a note",
        inputSchema: z.object({}),
        execute,
      }),
    });

    const result = await executionContext.run(
      {
        triggeredBy: "U123",
        triggerType: "user_message",
        channelId: "C123",
        threadTs: "1710000000.000000",
      },
      async () => {
        markTurnSuspendedByDetachedCommand("abcdef12");
        return (tools.read_note as any).execute({});
      },
    );

    expect(result).toEqual({
      ok: false,
      error: TOOL_CALL_AFTER_DETACHED_SUSPEND_ERROR,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("strict-mode JSON schema compatibility", () => {
  it("no tool inputSchema uses integer type with minimum/maximum", async () => {
    // Provider-side strict validation (defaulted on in #1317) rejects
    // { type: "integer", minimum, maximum } -- it surfaces as
    // "tools.N.custom: For 'integer' type, properties maximum, minimum are
    // not supported" and kills the whole turn, not just the tool call.
    // Use z.number().min().max() instead of z.number().int().min().max().
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "../tools");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.includes(".test.")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      // Collapse whitespace so multi-line builder chains are caught too --
      // the original single-line check missed
      //   z\n  .number()\n  .int()\n  .min(1)
      // which is how Prettier formats longer chains (see notes.ts/sandbox.ts).
      const flat = src.replace(/\s+/g, "");
      const re = /z\.number\(\)\.int\(\)\.(?:min|max)\(/g;
      if (re.test(flat)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
