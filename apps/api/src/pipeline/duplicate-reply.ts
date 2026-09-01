// ── Duplicate final message detection (issue #1343) ─────────────────────────
// When a turn posts its answer into the invoking thread via send_thread_reply
// (or send_channel_message into the invoking channel), the turn's own final
// assistant text often restates the same content — landing seconds later in
// the SAME place and reading as spam. These helpers detect (a) that a tool
// post targeted the turn's own delivery destination and (b) that the final
// text substantially duplicates what was already posted.

/** Slack conversation ids: channels (C…), DMs (D…), groups/MPIMs (G…). */
const SLACK_CONVERSATION_ID_PATTERN = /^[CDG][A-Z0-9]{6,}$/;

/**
 * If a Slack posting tool call targeted the turn's own delivery destination
 * (same channel + thread the final message would land in), return the posted
 * message text; otherwise null.
 *
 * The tools accept channel NAMES as well as ids and resolve them internally,
 * so an unverifiable name is treated as a match only when the thread_ts
 * matches (thread timestamps are unique enough to be the strong signal).
 */
export function getSameDestinationPostText(
  toolName: string,
  input: unknown,
  channelId: string,
  threadTs: string | undefined,
): string | null {
  if (!input || typeof input !== "object") return null;
  const args = input as Record<string, unknown>;
  const message = typeof args.message === "string" ? args.message : null;
  if (!message) return null;

  if (toolName === "send_thread_reply") {
    if (!threadTs || args.thread_ts !== threadTs) return null;
    const channel = args.channel;
    // An explicit DIFFERENT channel id rules the match out; a channel name
    // can't be verified here, so the thread_ts equality decides.
    if (
      typeof channel === "string" &&
      SLACK_CONVERSATION_ID_PATTERN.test(channel) &&
      channel !== channelId
    ) {
      return null;
    }
    return message;
  }

  if (toolName === "send_channel_message") {
    return args.channel === channelId ? message : null;
  }

  return null;
}

/**
 * Normalize text for duplicate comparison: lowercase, Slack entity syntax
 * (<@U…>, <#C…|name>, <url|label>) reduced to their label, emoji codes and
 * mrkdwn punctuation stripped, whitespace collapsed.
 */
export function normalizeForDuplicateComparison(text: string): string {
  return text
    .toLowerCase()
    // <@U123>, <!here> → drop; <#C123|name> / <url|label> → keep the label.
    .replace(/<[@!][^>]*>/g, " ")
    .replace(/<[^>|]*\|([^>]*)>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/:[a-z0-9_+-]+:/g, " ")
    .replace(/[*_~`>#|•·]/g, "")
    .replace(/[^\p{L}\p{N}\s.,%$@/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantWords(normalized: string): string[] {
  return normalized.split(" ").filter((w) => w.length > 2);
}

/** Minimum normalized length for containment to count as duplication. */
const MIN_CONTAINMENT_LENGTH = 20;
/** Minimum significant-word count for overlap scoring to be meaningful. */
const MIN_OVERLAP_WORDS = 8;
/** Fraction of the final text's significant words that must reappear. */
const OVERLAP_THRESHOLD = 0.8;

/**
 * True when `finalText` substantially duplicates any of `postedTexts`:
 * - exact match after normalization,
 * - the final text is contained in a posted message (it adds nothing),
 * - a posted message covers ≥80% of the final text's length via containment,
 * - or ≥80% of the final text's significant words appear in a posted message
 *   (catches "Posted in-thread. <restatement>" summaries of the same answer).
 */
export function isSubstantialDuplicate(
  finalText: string,
  postedTexts: string[],
): boolean {
  const final = normalizeForDuplicateComparison(finalText);
  if (!final) return false;
  const finalWords = significantWords(final);

  for (const postedText of postedTexts) {
    const posted = normalizeForDuplicateComparison(postedText);
    if (!posted) continue;

    if (posted === final) return true;

    if (final.length >= MIN_CONTAINMENT_LENGTH && posted.includes(final)) {
      return true;
    }
    if (
      posted.length >= MIN_CONTAINMENT_LENGTH &&
      final.includes(posted) &&
      posted.length / final.length >= OVERLAP_THRESHOLD
    ) {
      return true;
    }

    if (finalWords.length >= MIN_OVERLAP_WORDS) {
      const postedWordSet = new Set(significantWords(posted));
      const matched = finalWords.filter((w) => postedWordSet.has(w)).length;
      if (matched / finalWords.length >= OVERLAP_THRESHOLD) return true;
    }
  }

  return false;
}
