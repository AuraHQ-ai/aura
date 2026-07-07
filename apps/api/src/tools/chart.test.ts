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

describe("draw_chart inline mode", () => {
  it("returns a native data_visualization block for line charts", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute({
      chart_type: "line",
      title: "Weekly Sales",
      series: [
        {
          name: "Online",
          data: [
            { label: "Week 1", value: 12 },
            { label: "Week 2", value: 18 },
          ],
        },
      ],
      axis_config: {
        categories: ["Week 1", "Week 2"],
        x_label: "Week",
        y_label: "Sales",
      },
    });

    expect(result.ok).toBe(true);
    expect(result[CHART_BLOCK_KEY]).toEqual({
      type: "data_visualization",
      title: "Weekly Sales",
      chart: {
        type: "line",
        series: [
          {
            name: "Online",
            data: [
              { label: "Week 1", value: 12 },
              { label: "Week 2", value: 18 },
            ],
          },
        ],
        axis_config: {
          categories: ["Week 1", "Week 2"],
          x_label: "Week",
          y_label: "Sales",
        },
      },
    });
  });

  it("returns a native data_visualization block for pie charts", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute({
      chart_type: "pie",
      title: "Market Split",
      segments: [
        { label: "Zurich", value: 45 },
        { label: "Geneva", value: 30 },
        { label: "Lausanne", value: 25 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result[CHART_BLOCK_KEY].type).toBe("data_visualization");
    expect(result[CHART_BLOCK_KEY].chart).toEqual({
      type: "pie",
      segments: [
        { label: "Zurich", value: 45 },
        { label: "Geneva", value: 30 },
        { label: "Lausanne", value: 25 },
      ],
    });
  });
});

describe("draw_chart validation", () => {
  it("requires non-pie series labels to match axis categories exactly", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute({
      chart_type: "bar",
      title: "Revenue",
      series: [
        {
          name: "Revenue",
          data: [
            { label: "Jan", value: 100 },
            { label: "Mar", value: 120 },
          ],
        },
      ],
      axis_config: {
        categories: ["Jan", "Feb"],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Series "Revenue" data point label "Mar" is not in axis_config.categories.',
    });
  });

  it("enforces the issue limit of 6 series", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute({
      chart_type: "area",
      title: "Users",
      series: Array.from({ length: 7 }, (_, index) => ({
        name: `S${index}`,
        data: [{ label: "Mon", value: index }],
      })),
      axis_config: {
        categories: ["Mon"],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "Max 6 series allowed.",
    });
  });

  it("enforces the issue limit of 6 pie segments", async () => {
    const fakeClient = {} as any;
    const tools = createChartTools(fakeClient);
    const result = await (tools.draw_chart as any).execute({
      chart_type: "pie",
      title: "Share",
      segments: Array.from({ length: 7 }, (_, index) => ({
        label: `S${index}`,
        value: index + 1,
      })),
    });

    expect(result).toEqual({
      ok: false,
      error: "Max 6 segments allowed.",
    });
  });
});
