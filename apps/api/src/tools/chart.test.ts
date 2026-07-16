import { describe, it, expect, vi } from "vitest";
import { CHART_BLOCK_KEY, createChartTools } from "./chart.js";

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

const pieInput = {
  chart_type: "pie",
  title: "Deals by stage",
  segments: [
    { label: "Won", value: 12 },
    { label: "Lost", value: 5 },
  ],
};

describe("draw_chart inline mode", () => {
  it("returns a native chart block", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute(pieInput);

    expect(result.ok).toBe(true);
    expect(result[CHART_BLOCK_KEY]).toBeDefined();
    expect(result[CHART_BLOCK_KEY].type).toBe("data_visualization");
  });

  it("reports the chart as queued, not delivered (issue #1180)", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute(pieInput);

    expect(result.ok).toBe(true);
    // Inline mode only queues the block — delivery happens later in the
    // pipeline and can fail, so the result must not claim delivery.
    expect(result.message).toMatch(/queued/i);
    expect(result.message).toMatch(/do not claim the user has seen it/i);
    expect(result.message).not.toMatch(/rendered|posted|sent/i);
    expect(result.ts).toBeUndefined();

    const output = (tools.draw_chart as any).slack.output(result);
    expect(output).toBe("Chart queued for delivery with the reply");
  });

  it("keeps affirmative wording for reply mode (synchronous post)", async () => {
    const fakeClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1710000001.000100" }),
      },
    } as any;
    const context = { channelId: "C123", threadTs: "1234.5678", timezone: "UTC" };
    const tools = createChartTools(fakeClient, context as any);
    const result = await (tools.draw_chart as any).execute({
      ...pieInput,
      send_as_reply: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1710000001.000100");
    expect(result.message).toBe("Chart posted as a thread reply.");

    const output = (tools.draw_chart as any).slack.output(result);
    expect(output).toBe("Chart rendered");
  });

  it("surfaces errors through slack output", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute({
      chart_type: "pie",
      title: "Missing segments",
    });

    expect(result.ok).toBe(false);
    const output = (tools.draw_chart as any).slack.output(result);
    expect(output).toBe(result.error);
  });
});
