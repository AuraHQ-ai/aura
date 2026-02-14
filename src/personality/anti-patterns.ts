/**
 * Anti-pattern post-processing (FR-3.2).
 *
 * A safety net that strips common AI-isms that leak through
 * despite the system prompt. The prompt should prevent most of these,
 * but this catches what slips through.
 */

/** Sycophantic openers to strip */
const SYCOPHANTIC_OPENERS = [
  /^Sure\b[!,.]?\s*/i,
  /^Absolutely[!,.]?\s*/i,
  /^Of course[!,.]?\s*/i,
  /^Great question[!,.]?\s*/i,
  /^That's a great question[!,.]?\s*/i,
  /^Certainly[!,.]?\s*/i,
  /^Definitely[!,.]?\s*/i,
  /^Happy to help[!,.]?\s*/i,
  /^I'd be happy to help[!,.]?\s*/i,
  /^I'd love to help[!,.]?\s*/i,
  /^No problem[!,.]?\s*/i,
  /^Thanks for asking[!,.]?\s*/i,
  /^That's an? (great|excellent|wonderful|fantastic|interesting) (question|point|observation)[!,.]?\s*/i,
];

/** AI disclaimers to strip */
const AI_DISCLAIMERS = [
  /As an AI( language model)?[,.]?\s*/gi,
  /As a large language model[,.]?\s*/gi,
  /I don't have personal (opinions|feelings|experiences),?\s*but\s*/gi,
  /I don't have personal (opinions|feelings|experiences),?\s*however\s*/gi,
  /While I'm (just )?an AI[,.]?\s*/gi,
  /I should note that I'm an AI[,.]?\s*/gi,
];

/** Hedge phrases to clean up */
const HEDGE_PHRASES = [
  /It's worth noting that\s*/gi,
  /It'?s important to (note|consider|remember|keep in mind) that\s*/gi,
  /However,?\s*it'?s important to (consider|note|remember)\s*/gi,
  /That being said,?\s*/gi,
  /Having said that,?\s*/gi,
  /With that being said,?\s*/gi,
  /I would like to point out that\s*/gi,
];

/** Words to flag (not auto-remove, just log) */
const FLAGGED_WORDS = ["delve", "utilize", "leverage", "synergy", "paradigm"];

/**
 * Strip sycophantic openers from the start of a response.
 * Only strips from the very beginning of the text.
 */
function stripSycophanticOpeners(text: string): string {
  let result = text;
  for (const pattern of SYCOPHANTIC_OPENERS) {
    result = result.replace(pattern, "");
  }
  // Capitalize the first letter if we stripped something
  if (result !== text && result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }
  return result;
}

/**
 * Strip AI disclaimers from anywhere in the text.
 */
function stripAIDisclaimers(text: string): string {
  let result = text;
  for (const pattern of AI_DISCLAIMERS) {
    result = result.replace(pattern, "");
  }
  return result;
}

/**
 * Strip hedge phrases from anywhere in the text.
 */
function stripHedgePhrases(text: string): string {
  let result = text;
  for (const pattern of HEDGE_PHRASES) {
    result = result.replace(pattern, "");
  }
  return result;
}

/**
 * Check for flagged words and return them (for logging/metrics).
 */
export function detectFlaggedWords(text: string): string[] {
  const lower = text.toLowerCase();
  return FLAGGED_WORDS.filter((word) => lower.includes(word));
}

/**
 * Main post-processing function.
 * Strips anti-patterns from LLM output and returns cleaned text.
 */
export function postProcessResponse(text: string): {
  cleaned: string;
  flaggedWords: string[];
  modifications: string[];
} {
  const modifications: string[] = [];
  let result = text;

  // Strip sycophantic openers
  const afterOpeners = stripSycophanticOpeners(result);
  if (afterOpeners !== result) {
    modifications.push("stripped_sycophantic_opener");
    result = afterOpeners;
  }

  // Strip AI disclaimers
  const afterDisclaimers = stripAIDisclaimers(result);
  if (afterDisclaimers !== result) {
    modifications.push("stripped_ai_disclaimer");
    result = afterDisclaimers;
  }

  // Strip hedge phrases
  const afterHedges = stripHedgePhrases(result);
  if (afterHedges !== result) {
    modifications.push("stripped_hedge_phrase");
    result = afterHedges;
  }

  // Detect flagged words
  const flaggedWords = detectFlaggedWords(result);
  if (flaggedWords.length > 0) {
    modifications.push(`flagged_words: ${flaggedWords.join(", ")}`);
  }

  // Clean up any double spaces or leading/trailing whitespace
  result = result.replace(/  +/g, " ").trim();

  // Fix sentences that start with lowercase after stripping
  result = result.replace(/^\s*([a-z])/, (_, c) => c.toUpperCase());

  return { cleaned: result, flaggedWords, modifications };
}
