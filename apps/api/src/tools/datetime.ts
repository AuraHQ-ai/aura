import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { defineTool } from "../lib/tool.js";
import { getWeekCalendar } from "../lib/temporal.js";

const DEFAULT_TZ = "Europe/Amsterdam";

export function createDateTimeTools() {
  return {
    get_current_datetime: defineTool({
      description:
        "Return the current date, time, day-of-week, and a mini week calendar. " +
        "The current date/time is already in the system prompt — only call this tool when you need a different timezone or a fresh timestamp mid-conversation. " +
        "Do NOT call this just to check today's date before another tool call — use the date from your system context.",
      inputSchema: z.object({
        timezone: z
          .string()
          .optional()
          .describe(
            "IANA timezone, e.g. 'Europe/Amsterdam' or 'America/New_York'. Defaults to Europe/Amsterdam.",
          ),
      }),
      execute: async ({ timezone }) => {
        const tz = timezone || DEFAULT_TZ;
        const now = new Date();

        const date = formatInTimeZone(now, tz, "yyyy-MM-dd");
        const day = formatInTimeZone(now, tz, "EEEE");
        const time = formatInTimeZone(now, tz, "HH:mm");
        const iso = formatInTimeZone(now, tz, "yyyy-MM-dd'T'HH:mm:ssxxx");
        const weekCalendar = getWeekCalendar(now, tz);

        return {
          ok: true as const,
          date,
          day,
          time,
          timezone: tz,
          iso,
          week_calendar: weekCalendar,
        };
      },
      slack: { status: "Checking current date/time...", output: (r) => `${r.day}, ${r.date} ${r.time}` },
    }),
  };
}
