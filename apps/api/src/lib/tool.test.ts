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
