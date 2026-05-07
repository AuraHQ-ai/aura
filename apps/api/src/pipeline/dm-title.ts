/** Strip wrapping quotes and trailing punctuation that LLMs sometimes add despite instructions. */
export function sanitizeTitle(raw: string): string {
  return raw.trim().replace(/^["'""]+|["'""]+$/g, "").replace(/[.!;:]+$/, "").trim();
}

const REFUSAL_START_RE =
  /^(?:i\s|i'm|i\sdon|i\scannot|i\scan't|sorry[,\s]|unfortunately|as an ai|as an assistant)/i;

const REFUSAL_PHRASE_RE =
  /(?:enough context|unable to|don't have|not sure what|cannot determine|can't determine|no clear topic)/i;

const META_DESCRIPTION_RE =
  /^(?:user|assistant)\s+(?:ai\s+)?(?:frustration|confusion|profiling|inquiry|asking|asks|wants|needs|requests?)\b/i;

export function isValidTitle(title: string): boolean {
  const sanitized = sanitizeTitle(title);

  if (!sanitized || sanitized.length < 3) return false;
  if (/^skip$/i.test(sanitized)) return false;
  if (REFUSAL_START_RE.test(sanitized)) return false;
  if (REFUSAL_PHRASE_RE.test(sanitized)) return false;
  if (META_DESCRIPTION_RE.test(sanitized)) return false;

  return true;
}
