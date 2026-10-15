export const MCP_TOOL_PREFIX = "mcp__";

const SLUG_MAX = 48;

/**
 * Stable, unique-enough slug for `mcp_servers.slug` and tool names
 * `mcp__<slug>__<tool>`.
 */
export function slugifyMcpName(input: string): string {
  const stripped = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  let slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SLUG_MAX);
  if (!slug || !/^[a-z]/.test(slug)) {
    slug = `s_${slug || "server"}`.slice(0, SLUG_MAX);
  }
  return slug;
}

export function namespaceMcpTool(slug: string, toolName: string): string {
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${MCP_TOOL_PREFIX}${slug}__${safeTool}`;
}

export function parseNamespacedMcpTool(name: string): { slug: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep === rest.length - 2) return null;
  return { slug: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** env_allowlist entry that opts a job into one MCP server's tools. */
export function mcpEnvAllowlistName(slug: string): string {
  return `mcp:${slug}`;
}

export function isMcpServerAllowlisted(slug: string, envAllowlist: string[] | undefined): boolean {
  if (!envAllowlist) return false;
  const upper = `MCP_${slug.toUpperCase()}`;
  return envAllowlist.includes(mcpEnvAllowlistName(slug)) || envAllowlist.includes(upper);
}

const WRITE_NAME_RE =
  /(create|update|delete|write|send|post|put|patch|remove|insert|drop|grant|revoke|publish|cancel|close|set|add|edit|destroy)/i;

export function isWriteLikeMcpTool(
  toolName: string,
  annotations?: { readOnlyHint?: boolean },
): boolean {
  if (annotations?.readOnlyHint === true) return false;
  if (annotations?.readOnlyHint === false) return true;
  return WRITE_NAME_RE.test(toolName);
}
