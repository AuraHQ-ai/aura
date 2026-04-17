export const PRONOUN_REGEX =
  /\b(she|her|hers|herself|he|him|his|himself|they|them|their|themself)\b/gi;

type PronounToken =
  | "she"
  | "her"
  | "hers"
  | "herself"
  | "he"
  | "him"
  | "his"
  | "himself"
  | "they"
  | "them"
  | "their"
  | "themself";

export type PronounFamily = "feminine" | "masculine" | "neutral";
type PronounCategory =
  | "subject"
  | "object"
  | "possessiveAdjective"
  | "possessivePronoun"
  | "reflexive";

export interface PronounCounts {
  feminine: number;
  masculine: number;
  neutral: number;
}

export interface PronounScanResult {
  counts: PronounCounts;
  presentFamilies: PronounFamily[];
}

export type PronounClassification =
  | {
      kind: "MATCH";
      reason: string;
      counts: PronounCounts;
      presentFamilies: PronounFamily[];
    }
  | {
      kind: "MISMATCH_SIMPLE";
      reason: string;
      counts: PronounCounts;
      presentFamilies: PronounFamily[];
      sourceFamily: PronounFamily;
      targetFamily: PronounFamily;
    }
  | {
      kind: "MISMATCH_COMPLEX";
      reason: string;
      counts: PronounCounts;
      presentFamilies: PronounFamily[];
      targetFamily: PronounFamily;
    };

export interface PronounPatchResult {
  summary: string;
  replacements: number;
  ambiguousChoices: string[];
}

const PRONOUN_TO_FAMILY: Record<PronounToken, PronounFamily> = {
  she: "feminine",
  her: "feminine",
  hers: "feminine",
  herself: "feminine",
  he: "masculine",
  him: "masculine",
  his: "masculine",
  himself: "masculine",
  they: "neutral",
  them: "neutral",
  their: "neutral",
  themself: "neutral",
};

const FAMILY_PRONOUNS: Record<PronounFamily, Record<PronounCategory, string>> = {
  feminine: {
    subject: "she",
    object: "her",
    possessiveAdjective: "her",
    possessivePronoun: "hers",
    reflexive: "herself",
  },
  masculine: {
    subject: "he",
    object: "him",
    possessiveAdjective: "his",
    possessivePronoun: "his",
    reflexive: "himself",
  },
  neutral: {
    subject: "they",
    object: "them",
    possessiveAdjective: "their",
    possessivePronoun: "theirs",
    reflexive: "themself",
  },
};

const MALE_GENDER_VALUES = new Set([
  "male",
  "man",
  "masculine",
  "he",
  "him",
  "he/him",
  "m",
]);

const FEMALE_GENDER_VALUES = new Set([
  "female",
  "woman",
  "feminine",
  "she",
  "her",
  "she/her",
  "f",
]);

const NEUTRAL_GENDER_VALUES = new Set([
  "non-binary",
  "nonbinary",
  "nb",
  "neutral",
  "they",
  "them",
  "they/them",
  "agender",
  "genderqueer",
]);

function emptyCounts(): PronounCounts {
  return {
    feminine: 0,
    masculine: 0,
    neutral: 0,
  };
}

export function normalizeGenderToPronounFamily(
  gender: string | null | undefined,
): PronounFamily | null {
  if (gender == null) return null;
  const normalized = gender.trim().toLowerCase();
  if (!normalized) return null;
  if (MALE_GENDER_VALUES.has(normalized)) return "masculine";
  if (FEMALE_GENDER_VALUES.has(normalized)) return "feminine";
  if (NEUTRAL_GENDER_VALUES.has(normalized)) return "neutral";
  return null;
}

export function scanPronouns(summary: string): PronounScanResult {
  const counts = emptyCounts();
  const matcher = new RegExp(PRONOUN_REGEX.source, PRONOUN_REGEX.flags);
  let match = matcher.exec(summary);

  while (match) {
    const token = match[0].toLowerCase() as PronounToken;
    const family = PRONOUN_TO_FAMILY[token];
    counts[family] += 1;
    match = matcher.exec(summary);
  }

  const presentFamilies = (Object.keys(counts) as PronounFamily[]).filter(
    (family) => counts[family] > 0,
  );

  return {
    counts,
    presentFamilies,
  };
}

export function classifyPronounSummary(
  summary: string,
  expectedFamily: PronounFamily,
): PronounClassification {
  const scan = scanPronouns(summary);

  if (scan.presentFamilies.length === 0) {
    return {
      kind: "MATCH",
      reason: "No tracked pronouns found in summary.",
      counts: scan.counts,
      presentFamilies: scan.presentFamilies,
    };
  }

  if (
    scan.presentFamilies.length === 1 &&
    scan.presentFamilies[0] === expectedFamily
  ) {
    return {
      kind: "MATCH",
      reason: "Summary pronouns align with user gender.",
      counts: scan.counts,
      presentFamilies: scan.presentFamilies,
    };
  }

  if (scan.presentFamilies.length === 1) {
    return {
      kind: "MISMATCH_SIMPLE",
      reason: `Summary only uses ${scan.presentFamilies[0]} pronouns; expected ${expectedFamily}.`,
      counts: scan.counts,
      presentFamilies: scan.presentFamilies,
      sourceFamily: scan.presentFamilies[0],
      targetFamily: expectedFamily,
    };
  }

  return {
    kind: "MISMATCH_COMPLEX",
    reason: `Summary has mixed pronoun families (${scan.presentFamilies.join(", ")}).`,
    counts: scan.counts,
    presentFamilies: scan.presentFamilies,
    targetFamily: expectedFamily,
  };
}

function detectCasePattern(token: string): "upper" | "title" | "lower" {
  if (token === token.toUpperCase()) return "upper";
  if (
    token.length > 0 &&
    token[0] === token[0].toUpperCase() &&
    token.slice(1) === token.slice(1).toLowerCase()
  ) {
    return "title";
  }
  return "lower";
}

function applyCasePattern(token: string, replacement: string): string {
  const pattern = detectCasePattern(token);
  if (pattern === "upper") return replacement.toUpperCase();
  if (pattern === "title") {
    return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement.toLowerCase();
}

function getPreviousWord(text: string, index: number): string | null {
  const before = text.slice(0, index);
  const match = before.match(/([A-Za-z]+)\W*$/);
  return match ? match[1].toLowerCase() : null;
}

function getNextWord(text: string, index: number): string | null {
  const after = text.slice(index);
  const match = after.match(/^\W*([A-Za-z]+)/);
  return match ? match[1].toLowerCase() : null;
}

function resolvePronounCategory(
  token: PronounToken,
  summary: string,
  matchStart: number,
  matchEnd: number,
): { category: PronounCategory; ambiguousReason?: string } {
  const previousWord = getPreviousWord(summary, matchStart);
  const nextWord = getNextWord(summary, matchEnd);

  switch (token) {
    case "she":
    case "he":
    case "they":
      return { category: "subject" };
    case "him":
    case "them":
      return { category: "object" };
    case "hers":
      return { category: "possessivePronoun" };
    case "herself":
    case "himself":
    case "themself":
      return { category: "reflexive" };
    case "her":
      if (previousWord === "to") return { category: "object" };
      if (nextWord) return { category: "possessiveAdjective" };
      return {
        category: "possessiveAdjective",
        ambiguousReason:
          "Ambiguous `her`; defaulted to possessive adjective mapping.",
      };
    case "his":
      if (nextWord) return { category: "possessiveAdjective" };
      return {
        category: "possessiveAdjective",
        ambiguousReason:
          "Ambiguous `his`; defaulted to possessive adjective mapping.",
      };
    case "their":
      if (nextWord) return { category: "possessiveAdjective" };
      return {
        category: "possessiveAdjective",
        ambiguousReason:
          "Ambiguous `their`; defaulted to possessive adjective mapping.",
      };
  }
}

export function patchSimplePronounMismatch(
  summary: string,
  sourceFamily: PronounFamily,
  targetFamily: PronounFamily,
): PronounPatchResult {
  if (sourceFamily === targetFamily) {
    return {
      summary,
      replacements: 0,
      ambiguousChoices: [],
    };
  }

  const ambiguousChoices: string[] = [];
  let replacements = 0;
  let cursor = 0;
  let output = "";
  const matcher = new RegExp(PRONOUN_REGEX.source, PRONOUN_REGEX.flags);
  let match = matcher.exec(summary);

  while (match) {
    const matchedPronoun = match[0];
    const matchedToken = matchedPronoun.toLowerCase() as PronounToken;
    const family = PRONOUN_TO_FAMILY[matchedToken];
    const matchStart = match.index;
    const matchEnd = matcher.lastIndex;

    output += summary.slice(cursor, matchStart);

    if (family !== sourceFamily) {
      output += matchedPronoun;
      cursor = matchEnd;
      match = matcher.exec(summary);
      continue;
    }

    const resolution = resolvePronounCategory(
      matchedToken,
      summary,
      matchStart,
      matchEnd,
    );
    const replacement =
      FAMILY_PRONOUNS[targetFamily][resolution.category] ?? matchedToken;
    const casedReplacement = applyCasePattern(matchedPronoun, replacement);

    if (resolution.ambiguousReason) {
      ambiguousChoices.push(
        `${resolution.ambiguousReason} Replaced "${matchedPronoun}" with "${casedReplacement}".`,
      );
    }

    if (casedReplacement !== matchedPronoun) {
      replacements += 1;
    }

    output += casedReplacement;
    cursor = matchEnd;
    match = matcher.exec(summary);
  }

  output += summary.slice(cursor);

  return {
    summary: output,
    replacements,
    ambiguousChoices,
  };
}
