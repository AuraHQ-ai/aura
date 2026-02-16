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
 * - Tables: pipe-delimited tables → wrapped in ``` code blocks
 */

/**
 * Detect markdown tables and wrap them in code blocks so they render
 * as aligned monospace text in Slack. Must run BEFORE other markdown
 * conversions to avoid mangling pipe characters.
 *
 * A markdown table is detected as 2+ consecutive lines where each line
 * contains at least one `|`. The second line must be a separator row
 * (contains `---`).
 *
 * Tables already inside code blocks are left untouched.
 */
function wrapTablesInCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;
  let inCodeBlock = false;

  while (i < lines.length) {
    // Track code block boundaries
    if (lines[i].trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(lines[i]);
      i++;
      continue;
    }

    // Skip table detection inside code blocks
    if (inCodeBlock) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Check if this line could be the start of a table:
    // current line is a table row, AND next line is a separator row
    if (
      isTableRow(lines[i]) &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      // Compute column count from the header to determine the minimum
      // pipe count for body rows (columns - 1 covers borderless rows).
      const columns = countColumns(lines[i]);
      const minPipes = columns - 1;
      // Collect all contiguous table rows (including separator)
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        (isSeparatorRow(lines[i]) ||
          (isTableRow(lines[i]) && countPipes(lines[i]) >= minPipes))
      ) {
        tableLines.push(lines[i]);
        i++;
      }
      // Wrap the table in a code block
      result.push("```");
      result.push(...tableLines);
      result.push("```");
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

/** A table row contains at least one pipe character and has word content */
function isTableRow(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  // Must have at least some word content (not just pipes and dashes)
  return /\w/.test(trimmed);
}

/** A separator row looks like |---|---|---| or ---|---|--- with optional colons for alignment */
function isSeparatorRow(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  // Must contain pipes and dashes; only pipes, dashes, colons, spaces allowed
  return /^\|?[\s\-:|]+\|[\s\-:|]+\|?$/.test(trimmed);
}

/** Count the number of data columns in a table row */
function countColumns(line: string): number {
  return line
    .trim()
    .split("|")
    .filter((p) => p.trim() !== "").length;
}

/** Count the number of pipe characters in a line */
function countPipes(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === "|") count++;
  }
  return count;
}

/**
 * Apply markdown-to-mrkdwn conversions to a segment of text that is
 * known to be outside any code block.
 */
function convertMarkdownSegment(segment: string): string {
  let s = segment;

  // Convert headers (## Header → *Header*)
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert links: [text](url) → <url|text>
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert bold: **text** → *text* (via placeholder to avoid italic conflict)
  s = s.replace(/\*\*(.+?)\*\*/g, "\x00BOLD$1\x00BOLD");

  // Convert italic: *text* → _text_ (must happen after bold placeholder)
  s = s.replace(/\*(.+?)\*/g, "_$1_");

  // Restore bold placeholders to Slack bold *text*
  s = s.replace(/\x00BOLD(.+?)\x00BOLD/g, "*$1*");

  // Convert strikethrough: ~~text~~ → ~text~
  s = s.replace(/~~(.+?)~~/g, "~$1~");

  return s;
}

/**
 * Convert standard Markdown to Slack mrkdwn.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  // Wrap tables in code blocks FIRST, before any other conversions
  const text = wrapTablesInCodeBlocks(markdown);

  // Split into code-block and non-code-block segments so markdown
  // conversions don't modify content inside code fences.
  const segments = text.split(/(```[\s\S]*?```)/g);

  return segments
    .map((segment) => {
      if (segment.startsWith("```")) {
        // Only strip language tags from code blocks
        return segment.replace(/```[a-zA-Z]*\n/, "```\n");
      }
      return convertMarkdownSegment(segment);
    })
    .join("");
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
