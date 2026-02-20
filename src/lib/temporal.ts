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
 * Convert any timestamp to human-readable format with combined absolute + relative time.
 * Output: "Fri, 20 Feb 2026, 09:32 CET (3h ago)" or "Fri, 20 Feb 2026, 09:32 CET" (if > 7 days old)
 *
 * Accepts: Slack ts string ("1771561968.163239"), ISO string, Date object, epoch number
 * timezone: IANA timezone string, defaults to "Europe/Zurich"
 */
export function formatTimestamp(
  input: string | number | Date,
  timezone?: string,
): string {
  const tz = timezone || "Europe/Zurich";
  const date = parseToDate(input);
  if (!date || isNaN(date.getTime())) return String(input);

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const tzAbbr = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value || tz;

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";

  const absolute = `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${tzAbbr}`;

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0 || diffMs > 7 * 24 * 60 * 60 * 1000) return absolute;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let rel: string;
  if (seconds < 60) rel = "just now";
  else if (minutes < 60) rel = `${minutes}m ago`;
  else if (hours < 24) rel = `${hours}h ago`;
  else if (days === 1) rel = "yesterday";
  else rel = `${days}d ago`;

  return `${absolute} (${rel})`;
}

function parseToDate(input: string | number | Date): Date | null {
  if (input instanceof Date) return input;

  if (typeof input === "number") {
    return input > 1e12 ? new Date(input) : new Date(input * 1000);
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // Slack ts: digits with a dot and microsecond decimal (e.g. "1771561968.163239")
    if (/^\d+\.\d+$/.test(trimmed)) {
      const epochSeconds = parseFloat(trimmed);
      return new Date(epochSeconds * 1000);
    }

    // Pure numeric string (epoch seconds)
    if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return n > 1e12 ? new Date(n) : new Date(n * 1000);
    }

    // ISO string — handle truncated timezone offset like "+00" -> "+00:00"
    let iso = trimmed;
    if (/[+-]\d{2}$/.test(iso)) {
      iso += ":00";
    }
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
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
