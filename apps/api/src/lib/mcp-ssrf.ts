import { isPrivateUrl } from "./ssrf.js";

export const MCP_SSRF_MAX_REDIRECTS = 5;

export class McpSsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSsrfError";
  }
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new McpSsrfError("Invalid MCP URL");
  }
}

/**
 * MCP server (and discovered OAuth authorization-server) URLs must be https
 * and must not resolve to private/loopback/link-local addresses.
 */
export async function assertPublicHttpsUrl(url: string): Promise<URL> {
  const parsed = parseUrl(url);
  if (parsed.protocol !== "https:") {
    throw new McpSsrfError("MCP URL must use https");
  }
  if (await isPrivateUrl(parsed.href)) {
    throw new McpSsrfError(
      "MCP URL resolves to a private, loopback, or link-local address",
    );
  }
  return parsed;
}

export type RedirectFetch = (
  input: string,
  init: { method: string; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/**
 * Validate `url` and every redirect hop (Location) the same way. Used when
 * probing a user-supplied MCP URL so a 302 to 169.254.169.254 is rejected.
 */
export async function assertPublicHttpsUrlFollowingRedirects(
  url: string,
  fetchFn: RedirectFetch = fetch as RedirectFetch,
  maxRedirects = MCP_SSRF_MAX_REDIRECTS,
): Promise<URL> {
  let current = await assertPublicHttpsUrl(url);

  for (let hop = 0; hop < maxRedirects; hop++) {
    let response: { status: number; headers: { get(name: string): string | null } };
    try {
      response = await fetchFn(current.href, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      if (error instanceof McpSsrfError) throw error;
      // Probe failure is not an SSRF miss — the URL itself already passed.
      return current;
    }

    if (response.status < 300 || response.status >= 400) {
      return current;
    }

    const location = response.headers.get("location");
    if (!location) return current;
    current = await assertPublicHttpsUrl(new URL(location, current).href);
  }

  throw new McpSsrfError(`MCP URL exceeded ${maxRedirects} redirects`);
}
