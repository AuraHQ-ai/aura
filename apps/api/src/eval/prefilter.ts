import type { EvalTurn } from "./windowing.js";

export const PREFILTER_JUDGE_MODEL = "prefilter-v1";

export interface PrefilterResult {
  scorable: false;
  rule: string;
  note: string;
}

const PURE_ACKS = new Set([
  "done",
  "got it",
  "ok",
  "okay",
  "on it",
  "sure",
  "sure thing",
  "thanks",
  "thank you",
  "will do",
]);

const WAITING_PHRASES = new Set([
  "give me a minute",
  "give me a moment",
  "hang on",
  "one moment",
  "one sec",
  "one second",
]);

function trimForMatching(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`*_~.,!?:;()[\]{}<>-]+|[\s"'`*_~.,!?:;()[\]{}<>-]+$/g, "")
    .toLowerCase();
}

function hasToolEvidence(turn: EvalTurn): boolean {
  return turn.toolNames.length > 0;
}

function isPureReaction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return false;

  const slackEmoji = /:[a-z0-9_+\-]+:/gi;
  const withoutSlackEmoji = trimmed.replace(slackEmoji, "");
  if (withoutSlackEmoji.trim().length === 0) return true;

  return /^(?:[\s.,!?+\-_*~`'"()[\]{}<>]|\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)+$/u.test(
    withoutSlackEmoji,
  );
}

function isProgressPing(normalized: string): boolean {
  return (
    /^(?:i(?:'|\u2019)?m |im )?(?:on it|checking|checking now|looking|looking now|looking into it|looking into this|taking a look|working on it)(?: now)?$/.test(
      normalized,
    ) ||
    /^(?:i(?:'|\u2019)?ll|i will) (?:check|look into|take a look|dig into|investigate)(?: it| this| that)?(?: and (?:get back to you|report back|follow up))?$/.test(
      normalized,
    ) ||
    /^let me (?:check|look|take a look|dig in|investigate)(?: it| this| that)?(?: and (?:i(?:'|\u2019)?ll )?(?:get back to you|report back|follow up))?$/.test(
      normalized,
    )
  );
}

function isOperationalStatus(normalized: string): boolean {
  if (normalized.length > 120) return false;

  return (
    /^(?:now )?let me (?:check|read|compose|send|build|compile|dispatch|commit|push|post|update|report|brief|dm|file|deploy|test|open|create|run)\b.+[:.]?$/.test(
      normalized,
    ) ||
    /^(?:now )?(?:checking|reading|composing|sending|building|compiling|dispatching|committing|pushing|posting|updating|reporting|deploying|testing)\b.*[:.]?$/.test(
      normalized,
    ) ||
    /^(?:good|clean|looks good|pr created|deployed|good data|there it is)\. (?:now )?(?:let me )?(?:commit|push|post|update|report|deploy|test|send|compile|dispatch)\b.+[:.]?$/.test(
      normalized,
    ) ||
    /^i see .+\blet me check\b.+$/.test(normalized) ||
    /^generic slackbot notification(?: again)? -- .*(?:nothing actionable|ignoring)\.?$/.test(
      normalized,
    )
  );
}

/**
 * Cheap, conservative not_scorable detector for obvious acks/progress pings.
 *
 * It intentionally avoids broad "short answer" rules: terse completions such
 * as "yes, merged, commit be511f4" should keep going to the judge.
 */
export function prefilterNotScorable(turn: EvalTurn): PrefilterResult | null {
  if (turn.role !== "assistant" || !turn.partId) return null;

  const text = turn.text.trim();
  if (!text) return null;

  if (!hasToolEvidence(turn) && isPureReaction(text)) {
    return {
      scorable: false,
      rule: "pure_reaction",
      note: "prefilter-v1: pure_reaction",
    };
  }

  const normalized = trimForMatching(text);
  if (!normalized) return null;

  if (!hasToolEvidence(turn) && PURE_ACKS.has(normalized)) {
    return {
      scorable: false,
      rule: "pure_ack",
      note: "prefilter-v1: pure_ack",
    };
  }

  if (!hasToolEvidence(turn) && WAITING_PHRASES.has(normalized)) {
    return {
      scorable: false,
      rule: "waiting_ping",
      note: "prefilter-v1: waiting_ping",
    };
  }

  if (isProgressPing(normalized)) {
    return {
      scorable: false,
      rule: "progress_ping",
      note: "prefilter-v1: progress_ping",
    };
  }

  if (isOperationalStatus(normalized)) {
    return {
      scorable: false,
      rule: "operational_status",
      note: "prefilter-v1: operational_status",
    };
  }

  return null;
}
