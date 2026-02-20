/**
 * Temporal awareness helpers (FR-6).
 *
 * Provides current-time context for the system prompt,
 * relative-time formatting for memory references,
 * and relative-time parsing for scheduling.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Get a human-readable current-time string for injection into the system prompt.
 * Optionally accepts a timezone (IANA), defaults to UTC.
 */
export function getCurrentTimeContext(timezone?: string): string {
  const tz = timezone || "UTC";
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const formatted = formatter.format(now);
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
    return `back in ${MONTHS[date.getMonth()]}`;
  }

  return `back in ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Format any timestamp into a human-readable string like
 * "Fri, 20 Feb, 09:32 CET (3h ago)".
 *
 * Accepts Slack ts ("1740044000.123456"), ISO string, Date, or epoch number.
 * Handles Postgres truncated "+00" timezone suffix.
 * Relative part only shown for timestamps < 7 days old.
 *
 * @param ts  The timestamp to format
 * @param tz  IANA timezone, defaults to "Europe/Zurich"
 */
export function formatTimestamp(
  ts: string | number | Date | null | undefined,
  tz: string = "Europe/Zurich",
): string {
  if (ts == null || ts === "") return "";

  let date: Date;
  if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === "number") {
    // Epoch seconds (< 1e12) vs milliseconds
    date = new Date(ts < 1e12 ? ts * 1000 : ts);
  } else {
    // Handle Postgres truncated "+00" timezone (not valid ISO 8601)
    let normalized = ts;
    if (/\+\d{2}$/.test(normalized)) {
      normalized = normalized.replace(/\+(\d{2})$/, "+$1:00");
    }
    // Slack ts: "1740044000.123456" — numeric with optional decimal
    if (/^\d+(\.\d+)?$/.test(normalized)) {
      date = new Date(parseFloat(normalized) * 1000);
    } else {
      date = new Date(normalized);
    }
  }

  if (isNaN(date.getTime())) return String(ts);

  // Format the date in the target timezone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const day = get("day");
  const month = get("month");
  const hour = get("hour");
  const minute = get("minute");

  // Get short timezone abbreviation (e.g. "CET", "CEST")
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value ?? tz;

  const absolute = `${weekday}, ${day} ${month}, ${hour}:${minute} ${tzAbbr}`;

  // Relative part (only for < 7 days)
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0 || diffMs >= 7 * 24 * 60 * 60 * 1000) return absolute;

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  let relative: string;
  if (diffSec < 60) relative = "just now";
  else if (diffMin < 60) relative = `${diffMin}m ago`;
  else if (diffHr < 24) relative = `${diffHr}h ago`;
  else if (diffDays === 1) relative = "yesterday";
  else relative = `${diffDays}d ago`;

  return `${absolute} (${relative})`;
}

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
