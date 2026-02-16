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
 * Slack's actual message size limit is ~40,000 characters for both
 * chat.postMessage and chat.update. We use 39,000 as a safe ceiling
 * to leave room for any metadata or encoding overhead.
 */
const SLACK_MAX_LENGTH = 39_000;

/**
 * Split a long message into multiple Slack-safe chunks.
 *
 * Prefers splitting at double-newlines (paragraph boundaries), then single
 * newlines, then sentence ends. Each chunk is guaranteed to be within
 * SLACK_MAX_LENGTH. In practice, LLM responses rarely exceed 39k, so this
 * usually returns a single-element array.
 */
export function splitForSlack(
  text: string,
  maxLength = SLACK_MAX_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.substring(0, maxLength);

    // Try paragraph boundary first (\n\n)
    let cutPoint = window.lastIndexOf("\n\n");
    if (cutPoint > maxLength * 0.5) {
      chunks.push(remaining.substring(0, cutPoint).trimEnd());
      remaining = remaining.substring(cutPoint).trimStart();
      continue;
    }

    // Try single newline
    cutPoint = window.lastIndexOf("\n");
    if (cutPoint > maxLength * 0.5) {
      chunks.push(remaining.substring(0, cutPoint).trimEnd());
      remaining = remaining.substring(cutPoint).trimStart();
      continue;
    }

    // Try sentence end
    cutPoint = window.lastIndexOf(". ");
    if (cutPoint > maxLength * 0.3) {
      chunks.push(remaining.substring(0, cutPoint + 1));
      remaining = remaining.substring(cutPoint + 2).trimStart();
      continue;
    }

    // Hard cut as last resort
    chunks.push(remaining.substring(0, maxLength));
    remaining = remaining.substring(maxLength);
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Format the LLM response for posting to Slack.
 * Returns one or more message chunks, each within Slack's size limit.
 */
export function formatForSlack(llmOutput: string): string[] {
  const mrkdwn = markdownToSlackMrkdwn(llmOutput);
  return splitForSlack(mrkdwn);
}
