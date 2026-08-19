import { describe, it, expect, vi } from "vitest";
import { TABLE_BLOCK_KEY, createTableTools } from "./table.js";
import { buildMessageContext } from "../pipeline/context.js";

vi.mock("../db/client.js", () => ({
  db: {},
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("draw_table inline mode", () => {
  it("returns a native table block (not monospace)", async () => {
    const fakeClient = {} as any;
    const tools = createTableTools(fakeClient);
    const result = await (tools.draw_table as any).execute({
      rows: [
        ["Name", "Score"],
        ["Alice", "95"],
        ["Bob", "87"],
      ],
    });

    expect(result.ok).toBe(true);
    expect(result[TABLE_BLOCK_KEY]).toBeDefined();
    expect(result[TABLE_BLOCK_KEY].type).toBe("table");
    expect(result[TABLE_BLOCK_KEY].rows).toHaveLength(3);
  });

  it("reports the table as queued, not delivered (issue #1180)", async () => {
    const fakeClient = {} as any;
    const tools = createTableTools(fakeClient);
    const result = await (tools.draw_table as any).execute({
      rows: [
        ["Name", "Score"],
        ["Alice", "95"],
      ],
    });

    expect(result.ok).toBe(true);
    // Inline mode only queues the block — delivery happens later in the
    // pipeline and can fail, so the result must not claim delivery.
    expect(result.message).toMatch(/queued/i);
    expect(result.message).toMatch(/do not claim the user has seen it/i);
    expect(result.message).not.toMatch(/rendered|posted|sent/i);
    expect(result.ts).toBeUndefined();

    const output = (tools.draw_table as any).slack.output(result);
    expect(output).toBe("Table queued for delivery with the reply");
  });

  it("keeps affirmative wording for reply mode (synchronous post)", async () => {
    const fakeClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1710000001.000100" }),
      },
    } as any;
    const context = { channelId: "C123", threadTs: "1234.5678", timezone: "UTC" };
    const tools = createTableTools(fakeClient, context as any);
    const result = await (tools.draw_table as any).execute({
      rows: [
        ["Name", "Score"],
        ["Alice", "95"],
      ],
      send_as_reply: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1710000001.000100");
    expect(result.message).toBe("Table posted as a thread reply.");

    const output = (tools.draw_table as any).slack.output(result);
    expect(output).toBe("Table rendered");
  });

  it("surfaces errors through slack output", async () => {
    const fakeClient = {} as any;
    const tools = createTableTools(fakeClient);
    const result = await (tools.draw_table as any).execute({
      rows: [["only-header"]],
    });

    expect(result.ok).toBe(false);
    const output = (tools.draw_table as any).slack.output(result);
    expect(output).toBe(result.error);
  });

  it("returns a native table block regardless of channel type context", async () => {
    const fakeClient = {} as any;
    // Simulate MPIM context
    const mpimContext = { channelId: "G01ABCDEF", threadTs: "1234.5678", timezone: "UTC" };
    const tools = createTableTools(fakeClient, mpimContext as any);
    const result = await (tools.draw_table as any).execute({
      rows: [
        ["Metric", "Value"],
        ["Revenue", "$100k"],
      ],
    });

    expect(result.ok).toBe(true);
    expect(result[TABLE_BLOCK_KEY]).toBeDefined();
    expect(result[TABLE_BLOCK_KEY].type).toBe("table");
  });
});

describe("MPIM channel type resolution", () => {
  it("resolves mpim channel_type to 'mpim' ChannelType", () => {
    const event = {
      type: "message" as const,
      channel: "G01ABCDEF",
      ts: "1234.5678",
      text: "hello",
      user: "U_USER",
      channel_type: "mpim",
    };
    const ctx = buildMessageContext(event, "U_BOT");
    expect(ctx).not.toBeNull();
    expect(ctx!.channelType).toBe("mpim");
  });

  it("sets isDm to true for mpim channels", () => {
    const event = {
      type: "message" as const,
      channel: "G01ABCDEF",
      ts: "1234.5678",
      text: "hello",
      user: "U_USER",
      channel_type: "mpim",
    };
    const ctx = buildMessageContext(event, "U_BOT");
    expect(ctx).not.toBeNull();
    expect(ctx!.isDm).toBe(true);
  });

  it("resolves im channel_type to dm with isDm true", () => {
    const event = {
      type: "message" as const,
      channel: "D01ABCDEF",
      ts: "1234.5678",
      text: "hello",
      user: "U_USER",
      channel_type: "im",
    };
    const ctx = buildMessageContext(event, "U_BOT");
    expect(ctx).not.toBeNull();
    expect(ctx!.channelType).toBe("dm");
    expect(ctx!.isDm).toBe(true);
  });

  it("resolves group channel_type to private_channel with isDm false", () => {
    const event = {
      type: "message" as const,
      channel: "G01ABCDEF",
      ts: "1234.5678",
      text: "hello",
      user: "U_USER",
      channel_type: "group",
    };
    const ctx = buildMessageContext(event, "U_BOT");
    expect(ctx).not.toBeNull();
    expect(ctx!.channelType).toBe("private_channel");
    expect(ctx!.isDm).toBe(false);
  });
});
