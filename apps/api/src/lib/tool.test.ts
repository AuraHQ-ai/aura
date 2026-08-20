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

describe("defineTool result cap", () => {
  const MARKER_RE = /\.\.\. \[truncated \d+ chars of \d+.*narrow the query or paginate\]/;

  function makeTool(
    result: unknown,
    maxResultChars?: number | false,
  ): (input: unknown) => Promise<unknown> {
    dbMocks.returning.mockResolvedValue([{ id: "log-1" }]);
    dbMocks.updateWhere.mockResolvedValue(undefined);
    const tools = registerToolNames({
      big_tool: defineTool({
        description: "a tool with a big result",
        inputSchema: z.object({}),
        ...(maxResultChars !== undefined ? { maxResultChars } : {}),
        execute: async () => result,
      }),
    });
    return (tools.big_tool as any).execute;
  }

  it("applies the 12k default cap when no cap config is given", async () => {
    const execute = makeTool({ ok: true, content: "x".repeat(50000) });
    const capped = await execute({});
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(12000);
    expect((capped as any)._truncated).toBe(true);
    expect((capped as any).content).toMatch(MARKER_RE);
  });

  it("respects an explicit maxResultChars override", async () => {
    const execute = makeTool({ ok: true, content: "x".repeat(50000) }, 2000);
    const capped = await execute({});
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(2000);
    expect((capped as any).content).toMatch(MARKER_RE);
  });

  it("maxResultChars: false opts out entirely", async () => {
    const result = { ok: true, content: "x".repeat(50000) };
    const execute = makeTool(result, false);
    expect(await execute({})).toBe(result);
  });

  it("degrades array-heavy results by dropping items, keeping valid JSON", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `row-${i}`,
      padding: "p".repeat(50),
    }));
    const execute = makeTool({ ok: true, rows, total_rows: 1000 });
    const capped = (await execute({})) as any;

    const serialized = JSON.stringify(capped);
    expect(serialized.length).toBeLessThanOrEqual(12000);
    expect(JSON.parse(serialized)).toEqual(capped);
    expect(capped.ok).toBe(true);
    expect(capped.total_rows).toBe(1000);
    expect(capped._truncated).toBe(true);
    expect(capped._note).toMatch(MARKER_RE);
    expect(capped.rows.length).toBeLessThan(1000);
    expect(capped.rows).toEqual(rows.slice(0, capped.rows.length));
  });

  it("leaves results under the cap untouched", async () => {
    const result = { ok: true, message: "small" };
    const execute = makeTool(result);
    expect(await execute({})).toBe(result);
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
      for (const [i, line] of src.split("\n").entries()) {
        if (/z\.number\(\)\.int\(\)/.test(line) && /\.(min|max)\(/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
