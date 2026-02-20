/**
 * Temporal awareness helpers (FR-6).
 *
 * Provides current-time context for the system prompt,
 * relative-time formatting for memory references,
 * and relative-time parsing for scheduling.
 */

import { format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Format a Date as ISO 8601 in the given IANA timezone.
 * Example: "2026-02-20T10:32:52+01:00"
 */
function toIso8601InTimezone(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/**
 * Get a human-readable current-time string for injection into the system prompt.
 * Optionally accepts a timezone (IANA), defaults to UTC.
 */
export function getCurrentTimeContext(timezone?: string): string {
  const tz = timezone || "UTC";
  const now = new Date();

  const formatted = formatInTimeZone(
    now,
    tz,
    "EEEE, MMMM d, yyyy h:mm a",
  );

  return `Current time: ${formatted} (${tz})`;
}

/**
 * Format a timestamp as a relative time string, e.g.
 * "just now", "5 minutes ago", "3 days ago", "about 2 weeks ago", "back in January".
 */
export function relativeTime(date: Date, now?: Date): string {
  const reference = now || new Date();
  const diffMs = reference.getTime() - date.getTime();

  if (diffMs < 0) return "in the future";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (weeks === 1) return "about a week ago";
  if (weeks < 4) return `about ${weeks} weeks ago`;
  if (months <= 1) return "about a month ago";
  if (months < 12) {
    return `back in ${format(date, "MMMM")}`;
  }

  return `back in ${format(date, "MMMM yyyy")}`;
}

/**
 * Convert any timestamp to an ISO 8601 string in the given timezone.
 *
 * Accepted inputs:
 *  - Slack message ts (e.g. "1740045172.123456")
 *  - ISO 8601 string ("2026-02-20T09:32:52Z")
 *  - Date object
 *  - Unix epoch in seconds or milliseconds (number)
 *
 * Output: "2026-02-20T10:32:52+01:00" (ISO 8601 in user timezone)
 *
 * @param input  Any supported timestamp format
 * @param timezone  IANA timezone string (default "UTC")
 */
export function formatTimestamp(
  input: string | number | Date | null | undefined,
  timezone?: string,
): string {
  if (input == null || input === "") return "";

  const tz = timezone || "UTC";
  let date: Date;

  if (input instanceof Date) {
    date = input;
  } else if (typeof input === "number") {
    date = input < 1e12 ? new Date(input * 1000) : new Date(input);
  } else {
    const asNum = Number(input);
    if (!isNaN(asNum) && asNum > 1e8) {
      date = asNum < 1e12 ? new Date(asNum * 1000) : new Date(asNum);
    } else {
      date = new Date(input);
    }
  }

  if (isNaN(date.getTime())) return String(input);

  try {
    return toIso8601InTimezone(date, tz);
  } catch {
    return toIso8601InTimezone(date, "UTC");
  }
}

/**
 * Parse a relative time string into milliseconds.
 * Supports: "30 minutes", "2 hours", "1 day", "3 days", "1 week", "tomorrow"
 */
export function parseRelativeTime(input: string): number | null {
  const cleaned = input.trim().toLowerCase();

  if (cleaned === "tomorrow") {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow.getTime() - Date.now();
  }

  const match = cleaned.match(
    /^(\d+)\s*(min(?:ute)?s?|h(?:our)?s?|d(?:ay)?s?|w(?:eek)?s?)$/,
  );
  if (!match) return null;

  const num = parseInt(match[1]);
  const unit = match[2];

  if (unit.startsWith("min")) return num * 60 * 1000;
  if (unit.startsWith("h")) return num * 60 * 60 * 1000;
  if (unit.startsWith("d")) return num * 24 * 60 * 60 * 1000;
  if (unit.startsWith("w")) return num * 7 * 24 * 60 * 60 * 1000;

  return null;
}
