/**
 * Convert LLM output to Slack mrkdwn format.
 *
 * The LLM outputs markdown. Slack uses "mrkdwn" which is similar but not identical.
 * Key differences:
 * - Bold: **text** → *text*
 * - Italic: *text* or _text_ → _text_
 * - Strikethrough: ~~text~~ → ~text~
 * - Code blocks: ```lang\n...\n``` → ```\n...\n``` (no language tag)
 * - Links: [text](url) → <url|text>
 * - Headers: ## Header → *Header*
 */

/**
 * Convert standard Markdown to Slack mrkdwn.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  let result = markdown;

  // Convert headers (## Header → *Header*)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert bold: **text** → *text* (via placeholder to avoid italic conflict)
  result = result.replace(/\*\*(.+?)\*\*/g, "\x00BOLD$1\x00BOLD");

  // Convert italic: *text* → _text_ (must happen after bold placeholder)
  result = result.replace(/\*(.+?)\*/g, "_$1_");

  // Restore bold placeholders to Slack bold *text*
  result = result.replace(/\x00BOLD(.+?)\x00BOLD/g, "*$1*");

  // Convert strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Strip language tags from code blocks: ```typescript → ```
  result = result.replace(/```[a-zA-Z]*\n/g, "```\n");

  return result;
}

/**
 * Truncate a message to Slack's character limit (4000 chars for regular messages).
 * If truncated, appends an ellipsis.
 */
export function truncateForSlack(
  text: string,
  maxLength = 3900,
): string {
  if (text.length <= maxLength) return text;

  // Try to truncate at a sentence or paragraph boundary
  const truncated = text.substring(0, maxLength);
  const lastNewline = truncated.lastIndexOf("\n");
  const lastPeriod = truncated.lastIndexOf(". ");

  const cutPoint = Math.max(lastNewline, lastPeriod);
  if (cutPoint > maxLength * 0.7) {
    return truncated.substring(0, cutPoint + 1) + "\n\n...";
  }

  return truncated + "...";
}

/**
 * Format the LLM response for posting to Slack.
 */
export function formatForSlack(llmOutput: string): string {
  const mrkdwn = markdownToSlackMrkdwn(llmOutput);
  return truncateForSlack(mrkdwn);
}
