/**
 * Convert LLM markdown to Slack mrkdwn.
 * Handles bold, italic, and heading syntax differences while preserving
 * code blocks, lists, and links (which share the same syntax).
 */
export function formatForSlack(text: string): string {
  // Protect fenced code blocks from transformation
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code spans from transformation
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00INLINE${inlineCode.length - 1}\x00`;
  });

  // Headers → bold (### heading, ## heading, # heading)
  // Strip inline bold/emphasis markers within headers since the whole header becomes bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_, content) => {
    const cleaned = content.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
    return `*${cleaned}*`;
  });
  // Bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Bold: __text__ → *text*
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Restore inline code spans
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => inlineCode[Number(idx)]);
  // Restore code blocks
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);

  return result;
}
