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
 * Parse a relative time string into milliseconds.
 * Supports: "30 minutes", "2 hours", "1 day", "3 days", "1 week", "tomorrow"
 */
/** Default timezone used when none is provided. */
export const DEFAULT_TIMEZONE = "Europe/Zurich";

/**
 * Format a timestamp into a human-readable string in the given timezone.
 *
 * Accepts:
 *  - Slack message timestamps ("1718920800.123456")
 *  - Unix epoch seconds (number)
 *  - ISO 8601 date strings ("2025-01-15T09:00:00Z")
 *  - Date objects
 *
 * Returns a string like "Mon, 20 Jan 2025, 10:35 AM (Europe/Zurich)".
 */
export function formatTimestamp(
  ts: string | number | Date,
  timezone?: string,
): string {
  const tz = timezone || DEFAULT_TIMEZONE;

  let date: Date;
  if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === "number") {
    date = new Date(ts * 1000);
  } else {
    // Slack timestamps look like "1718920800.123456" — pure numeric with optional dot
    const numeric = parseFloat(ts);
    if (!isNaN(numeric) && /^\d+(\.\d+)?$/.test(ts)) {
      date = new Date(numeric * 1000);
    } else {
      date = new Date(ts);
    }
  }

  if (isNaN(date.getTime())) {
    return String(ts);
  }

  let effectiveTz = tz;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    effectiveTz = DEFAULT_TIMEZONE;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: effectiveTz,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `${formatter.format(date)} (${effectiveTz})`;
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
