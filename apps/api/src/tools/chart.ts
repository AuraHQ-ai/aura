import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { formatForSlack } from "../lib/format.js";
import { resolveChannelByName, resolveUserByName } from "./slack.js";
import type { ScheduleContext } from "@aura/db/schema";
import { formatTimestamp } from "../lib/temporal.js";

/**
 * Sentinel key used by the pipeline to detect chart blocks in tool results.
 * When draw_chart is called in inline mode, the execute function returns the
 * built Slack data_visualization block under this key so respond.ts can attach
 * it to the current Slack stream.
 */
export const CHART_BLOCK_KEY = "__chart_block";

const chartTypeSchema = z.enum(["line", "bar", "area", "pie"]);
type ChartType = z.infer<typeof chartTypeSchema>;

const segmentSchema = z.object({
  label: z
    .string()
    .min(1, "Segment label is required")
    .max(20, "Segment labels must be 20 characters or fewer")
    .describe("Segment label shown in the legend. Maximum 20 characters."),
  value: z
    .number()
    .positive("Segment value must be greater than 0")
    .describe("Numeric weight for this segment. Must be greater than 0."),
});

const dataPointSchema = z.object({
  label: z
    .string()
    .min(1, "Data point label is required")
    .max(20, "Data point labels must be 20 characters or fewer")
    .describe("X-axis category for this point. Must match an axis_config category."),
  value: z
    .number()
    .describe("Numeric y-axis value. Negative values are allowed."),
});

const seriesSchema = z.object({
  name: z
    .string()
    .min(1, "Series name is required")
    .max(20, "Series names must be 20 characters or fewer")
    .describe("Series name shown in the legend. Must be unique. Maximum 20 characters."),
  data: z
    .array(dataPointSchema)
    .min(1, "Need at least one data point")
    .max(20, "Max 20 data points per series")
    .describe("Ordered data points. Must include exactly one point for each axis_config category."),
});

const axisConfigSchema = z.object({
  categories: z
    .array(z.string().min(1).max(20))
    .min(1, "Need at least one category")
    .max(20, "Max 20 categories")
    .describe("X-axis categories in left-to-right order. Each must be 20 characters or fewer."),
  x_label: z
    .string()
    .max(50, "X-axis label must be 50 characters or fewer")
    .optional()
    .describe("Optional x-axis title. Maximum 50 characters."),
  y_label: z
    .string()
    .max(50, "Y-axis label must be 50 characters or fewer")
    .optional()
    .describe("Optional y-axis title. Maximum 50 characters."),
});

type Segment = z.infer<typeof segmentSchema>;
type DataSeries = z.infer<typeof seriesSchema>;
type AxisConfig = z.infer<typeof axisConfigSchema>;

function hasDuplicates(values: string[]) {
  return new Set(values).size !== values.length;
}

function validateFiniteNumber(value: number, label: string) {
  return Number.isFinite(value) ? null : `${label} must be a finite number.`;
}

function validateSegments(segments: Segment[] | undefined) {
  if (!segments) return "Pie charts require segments.";
  if (segments.length < 1) return "Need at least one segment.";
  if (segments.length > 6) return "Max 6 segments allowed.";
  if (hasDuplicates(segments.map((segment) => segment.label))) {
    return "Segment labels must be unique.";
  }
  for (const [index, segment] of segments.entries()) {
    if (segment.label.length > 20) {
      return `Segment ${index} label must be 20 characters or fewer.`;
    }
    if (segment.value <= 0) {
      return `Segment ${index} value must be greater than 0.`;
    }
    const numberError = validateFiniteNumber(segment.value, `Segment ${index} value`);
    if (numberError) return numberError;
  }
  return null;
}

function validateAxisConfig(axisConfig: AxisConfig | undefined) {
  if (!axisConfig) return "Line, bar, and area charts require axis_config.";
  if (axisConfig.categories.length < 1) return "Need at least one category.";
  if (axisConfig.categories.length > 20) return "Max 20 categories allowed.";
  if (hasDuplicates(axisConfig.categories)) return "axis_config.categories must be unique.";
  for (const [index, category] of axisConfig.categories.entries()) {
    if (category.length > 20) {
      return `Category ${index} must be 20 characters or fewer.`;
    }
  }
  if (axisConfig.x_label && axisConfig.x_label.length > 50) {
    return "axis_config.x_label must be 50 characters or fewer.";
  }
  if (axisConfig.y_label && axisConfig.y_label.length > 50) {
    return "axis_config.y_label must be 50 characters or fewer.";
  }
  return null;
}

function validateSeries(series: DataSeries[] | undefined, axisConfig: AxisConfig | undefined) {
  if (!series) return "Line, bar, and area charts require series.";
  if (series.length < 1) return "Need at least one series.";
  if (series.length > 6) return "Max 6 series allowed.";
  if (hasDuplicates(series.map((item) => item.name))) {
    return "Series names must be unique.";
  }

  const axisError = validateAxisConfig(axisConfig);
  if (axisError) return axisError;
  const categories = axisConfig!.categories;
  const categorySet = new Set(categories);

  for (const [seriesIndex, item] of series.entries()) {
    if (item.name.length > 20) {
      return `Series ${seriesIndex} name must be 20 characters or fewer.`;
    }
    if (item.data.length !== categories.length) {
      return `Series "${item.name}" has ${item.data.length} data points but axis_config has ${categories.length} categories. Series must include exactly one data point per category.`;
    }
    if (hasDuplicates(item.data.map((point) => point.label))) {
      return `Series "${item.name}" has duplicate data point labels.`;
    }

    for (const [pointIndex, point] of item.data.entries()) {
      if (point.label.length > 20) {
        return `Series "${item.name}" data point ${pointIndex} label must be 20 characters or fewer.`;
      }
      if (!categorySet.has(point.label)) {
        return `Series "${item.name}" data point label "${point.label}" is not in axis_config.categories.`;
      }
      const numberError = validateFiniteNumber(
        point.value,
        `Series "${item.name}" data point ${pointIndex} value`,
      );
      if (numberError) return numberError;
    }
  }

  return null;
}

function validateChartInput(input: {
  chart_type: ChartType;
  title: string;
  segments?: Segment[];
  series?: DataSeries[];
  axis_config?: AxisConfig;
}) {
  if (!input.title.trim()) return "Title is required.";
  if (input.title.length > 50) return "Title must be 50 characters or fewer.";

  if (input.chart_type === "pie") {
    if (input.series || input.axis_config) {
      return "Pie charts use segments only; do not set series or axis_config.";
    }
    return validateSegments(input.segments);
  }

  if (input.segments) {
    return "Line, bar, and area charts use series and axis_config; do not set segments.";
  }
  return validateSeries(input.series, input.axis_config);
}

function buildChartBlock(input: {
  chart_type: ChartType;
  title: string;
  segments?: Segment[];
  series?: DataSeries[];
  axis_config?: AxisConfig;
}) {
  if (input.chart_type === "pie") {
    return {
      type: "data_visualization" as const,
      title: input.title,
      chart: {
        type: "pie" as const,
        segments: input.segments!,
      },
    };
  }

  return {
    type: "data_visualization" as const,
    title: input.title,
    chart: {
      type: input.chart_type,
      series: input.series!,
      axis_config: input.axis_config!,
    },
  };
}

async function postChart(
  client: WebClient,
  channelId: string,
  chartBlock: Record<string, any>,
  message?: string,
  threadTs?: string,
) {
  // Use chat.postMessage directly because the block is the content; stripping
  // it on invalid_blocks would make a chart request look successful without a chart.
  return client.chat.postMessage({
    channel: channelId,
    text: formatForSlack(message || "Here's a chart:"),
    blocks: [chartBlock as any],
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

export function createChartTools(client: WebClient, context?: ScheduleContext) {
  return {
    draw_chart: defineTool({
      description:
        "Render simple charts as native Slack data_visualization blocks. " +
        "Use this instead of generating PNG charts in the sandbox when the request fits Slack's native limits: " +
        "line, bar, area, or pie charts with up to 6 series/segments and up to 20 x-axis categories/data points. " +
        "Use sandbox/image rendering only for charts that need more series, custom styling, annotations, or unsupported chart types.\n\n" +
        "Inputs:\n" +
        "- `chart_type`: line, bar, area, or pie.\n" +
        "- `title`: required, max 50 characters.\n" +
        "- Pie charts: set `segments` only (1-6 items, label max 20 chars, value > 0).\n" +
        "- Line/bar/area charts: set `series` (1-6 series, unique names) and `axis_config`. " +
        "Every series must include exactly one data point for each `axis_config.categories` entry.\n\n" +
        "Three modes:\n" +
        "- **Inline** (default): chart attaches to the bottom of your current reply. " +
        "Limited to one native chart/table block per reply. Best for a single chart.\n" +
        "- **Reply** (`send_as_reply: true`): posts the chart as a separate thread reply in the current conversation. " +
        "Use this when you need multiple charts — they appear in the thread as you work. Include `message` for context.\n" +
        "- **Targeted** (`target_channel` or `target_user`): posts the chart to a different channel or DM. Include `message` for context.",
      inputSchema: z.object({
        chart_type: chartTypeSchema.describe("Chart type: line, bar, area, or pie."),
        title: z
          .string()
          .min(1, "Title is required")
          .max(50, "Title must be 50 characters or fewer")
          .describe("Short label displayed above the chart. Maximum 50 characters."),
        segments: z
          .array(segmentSchema)
          .min(1, "Need at least one segment")
          .max(6, "Max 6 segments")
          .optional()
          .describe("Pie chart segments. Required for pie charts; do not set for line/bar/area."),
        series: z
          .array(seriesSchema)
          .min(1, "Need at least one series")
          .max(6, "Max 6 series")
          .optional()
          .describe("Data series for line, bar, and area charts. Required for those chart types; do not set for pie."),
        axis_config: axisConfigSchema
          .optional()
          .describe("Axis configuration for line, bar, and area charts. Required for those chart types; do not set for pie."),
        send_as_reply: z
          .boolean()
          .optional()
          .describe(
            "Post the chart as a thread reply in the current conversation instead of inline. " +
            "Use when sending multiple charts.",
          ),
        target_channel: z
          .string()
          .optional()
          .describe(
            "Channel name or ID to post the chart to. Mutually exclusive with target_user and send_as_reply.",
          ),
        target_user: z
          .string()
          .optional()
          .describe(
            "User display name or ID to DM the chart to. Mutually exclusive with target_channel and send_as_reply.",
          ),
        thread_ts: z
          .string()
          .optional()
          .describe("Thread timestamp for targeted posts — post the chart as a thread reply."),
        message: z
          .string()
          .optional()
          .describe("Text above the chart. Recommended for reply and targeted modes."),
      }),
      execute: async ({
        chart_type,
        title,
        segments,
        series,
        axis_config,
        send_as_reply,
        target_channel,
        target_user,
        thread_ts,
        message,
      }) => {
        const error = validateChartInput({ chart_type, title, segments, series, axis_config });
        if (error) return { ok: false, error };

        if ((target_channel || target_user) && send_as_reply) {
          return { ok: false, error: "Use send_as_reply OR target_channel/target_user, not both." };
        }
        if (target_channel && target_user) {
          return { ok: false, error: "Set target_channel or target_user, not both." };
        }

        const chartBlock = buildChartBlock({ chart_type, title, segments, series, axis_config });
        const dataCount = chart_type === "pie" ? segments!.length : series!.length;

        // ── Inline mode: return block for pipeline injection ──────────
        if (!target_channel && !target_user && !send_as_reply) {
          logger.info("draw_chart tool called (inline)", {
            chartType: chart_type,
            dataCount,
          });
          // Inline blocks are only QUEUED here — actual delivery happens
          // later in the pipeline (stream append, stop payload, or a
          // postMessage fallback) and can still fail. Don't claim delivery.
          return {
            ok: true,
            [CHART_BLOCK_KEY]: chartBlock,
            message:
              "Chart queued — it will be attached when this reply is delivered. " +
              "Do not claim the user has seen it yet.",
          };
        }

        // ── Reply mode: post in the current conversation thread ──────
        if (send_as_reply) {
          if (!context?.channelId || !context?.threadTs) {
            return {
              ok: false,
              error: "No current conversation context available for send_as_reply.",
            };
          }

          try {
            const result = await postChart(
              client, context.channelId, chartBlock, message, context.threadTs,
            );
            logger.info("draw_chart tool called (reply)", {
              channelId: context.channelId,
              threadTs: context.threadTs,
              chartType: chart_type,
              dataCount,
              messageTs: result.ts,
            });
            return {
              ok: true,
              message: "Chart posted as a thread reply.",
              ts: result.ts,
              time: formatTimestamp(result.ts, context?.timezone),
            };
          } catch (err: any) {
            logger.error("draw_chart (reply) failed", { error: err.message });
            return { ok: false, error: `Failed to post chart reply: ${err.message}` };
          }
        }

        // ── Targeted mode: post to a specific channel or DM ──────────
        try {
          let channelId: string;

          if (target_user) {
            const user = await resolveUserByName(client, target_user);
            if (!user) {
              return { ok: false, error: `Could not find user "${target_user}".` };
            }
            const dm = await client.conversations.open({ users: user.id });
            if (!dm.channel?.id) {
              return { ok: false, error: `Failed to open DM with ${user.name}.` };
            }
            channelId = dm.channel.id;
          } else {
            const resolved = await resolveChannelByName(client, target_channel!);
            if (!resolved) {
              return { ok: false, error: `Could not find channel "${target_channel}".` };
            }
            channelId = resolved.id;
          }

          const result = await postChart(
            client, channelId, chartBlock, message, thread_ts,
          );

          const targetLabel = target_user || target_channel;
          logger.info("draw_chart tool called (targeted)", {
            target: targetLabel,
            chartType: chart_type,
            dataCount,
            messageTs: result.ts,
          });

          return {
            ok: true,
            message: `Chart sent to ${target_user ? target_user : `#${target_channel}`}`,
            ts: result.ts,
            time: formatTimestamp(result.ts, context?.timezone),
          };
        } catch (err: any) {
          logger.error("draw_chart (targeted) failed", { error: err.message });
          return { ok: false, error: `Failed to send chart: ${err.message}` };
        }
      },
      slack: {
        status: "Drawing chart...",
        // Posted results (reply/targeted) carry a real message `ts`; inline
        // results only queue the block for delivery with the reply.
        output: (r: any) =>
          r.ok === false
            ? r.error
            : r.ts
              ? "Chart rendered"
              : "Chart queued for delivery with the reply",
      },
    }),
  };
}
