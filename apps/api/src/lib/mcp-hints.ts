/**
 * Pure helpers for the per-caller `<mcp_servers>` prompt block (issue #1553).
 *
 * No DB, no MCP client — so dashboard DTO mapping and system-prompt formatting
 * share one implementation without pulling in tool/runtime modules.
 */

export const MCP_HINT_LINE_MAX = 300;
export const MCP_INSTRUCTIONS_STORE_MAX = 2048;

export type McpHintSource = "hint" | "instructions" | "registry";

export interface McpServerHintEntry {
  slug: string;
  toolCount: number;
  /** Admin-authored dashboard hint. Trusted. */
  hint?: string | null;
  /** Server-supplied MCP initialize instructions. Untrusted. */
  cachedInstructions?: string | null;
  /** Registry description or server display name. Plain text. */
  fallbackDescription?: string | null;
}

export interface ResolvedMcpHint {
  text: string;
  source: McpHintSource;
  untrusted: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0 controls is the point.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function sanitizeMcpPlainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Persist-time sanitizer: empty → null, hard-capped at 2 KB. */
export function sanitizeMcpInstructions(value: unknown): string | null {
  const cleaned = sanitizeMcpPlainText(value, MCP_INSTRUCTIONS_STORE_MAX);
  return cleaned || null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Untrusted server instructions must never merge verbatim into trusted prompt
 * text. Same convention as `mcp-runtime.ts` (`untrusted third-party MCP server`).
 */
export function wrapUntrustedMcpInstructions(slug: string, text: string): string {
  return (
    `<untrusted-mcp-instructions server="${escapeXml(slug)}">` +
    `${escapeXml(text)}` +
    `</untrusted-mcp-instructions>`
  );
}

export function resolveMcpServerHint(entry: McpServerHintEntry): ResolvedMcpHint {
  const trustedHint = sanitizeMcpPlainText(entry.hint, MCP_HINT_LINE_MAX);
  if (trustedHint) {
    return { text: trustedHint, source: "hint", untrusted: false };
  }

  const instructions = sanitizeMcpPlainText(entry.cachedInstructions, MCP_INSTRUCTIONS_STORE_MAX);
  if (instructions) {
    return {
      text: wrapUntrustedMcpInstructions(entry.slug, instructions),
      source: "instructions",
      untrusted: true,
    };
  }

  const fallback = sanitizeMcpPlainText(entry.fallbackDescription, MCP_HINT_LINE_MAX) || entry.slug;
  return { text: fallback, source: "registry", untrusted: false };
}

function capLine(line: string, max = MCP_HINT_LINE_MAX): string {
  if (line.length <= max) return line;
  if (max <= 3) return "...".slice(0, max);
  return `${line.slice(0, max - 3)}...`;
}

/**
 * One always-on line per live server. Tool names are intentionally omitted —
 * the slug is the BM25 prefix the model should search with.
 */
export function renderMcpServerHintLine(entry: McpServerHintEntry): string {
  const resolved = resolveMcpServerHint(entry);
  const suffix = `. Load with tool_search_tool_bm25 "${entry.slug} <topic>"`;
  const prefix = `- ${entry.slug} (${entry.toolCount} tools): `;
  const budget = MCP_HINT_LINE_MAX - prefix.length - suffix.length;
  let hintText = resolved.text;
  if (budget < 1) {
    return capLine(`${prefix}${hintText}${suffix}`);
  }
  if (hintText.length > budget) {
    hintText = budget <= 3 ? "..." : `${hintText.slice(0, budget - 3)}...`;
  }
  return `${prefix}${hintText}${suffix}`;
}

const MCP_SERVERS_INTRO =
  'Connected MCP servers. Prefix tool_search_tool_bm25 queries with the server slug (e.g. "close_fr aggregation") to load that server\'s tools.';

export function formatMcpServers(entries: McpServerHintEntry[] | undefined): string {
  if (!entries?.length) return "";
  const seen = new Set<string>();
  const sorted = [...entries]
    .filter((entry) => {
      if (!entry.slug || seen.has(entry.slug)) return false;
      seen.add(entry.slug);
      return true;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (sorted.length === 0) return "";

  return `<mcp_servers>
${MCP_SERVERS_INTRO}
${sorted.map(renderMcpServerHintLine).join("\n")}
</mcp_servers>`;
}
