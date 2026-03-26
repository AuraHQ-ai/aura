export const OAUTH_RETURN_TO_COOKIE = "oauth_return_to";

export const PRODUCTION_URL = "https://app.aurahq.ai";

/**
 * Resolves the app's base URL. On Vercel preview deployments, uses the
 * auto-provided VERCEL_URL so login redirects back to the preview — not prod.
 */
export function getAppUrl(): string {
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

const TRUSTED_DOMAIN_SUFFIXES = [".aurahq.ai"];

function parseTrustedOrigins(): string[] {
  const raw = process.env.TRUSTED_ORIGINS;
  if (!raw) return [];
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

/** Allow origins on trusted domains (HTTPS), explicitly configured origins, and localhost. */
export function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost")
      return url.protocol === "http:" || url.protocol === "https:";
    if (url.protocol !== "https:") return false;
    if (TRUSTED_DOMAIN_SUFFIXES.some(
      (suffix) => url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix),
    )) {
      return true;
    }
    return parseTrustedOrigins().includes(url.origin);
  } catch {
    return false;
  }
}

export function getSafeReturnTo(returnTo: string | null | undefined) {
  if (!returnTo || !returnTo.startsWith("/")) {
    return null;
  }

  // Reject protocol-relative URLs like //evil.com.
  if (returnTo.startsWith("//")) {
    return null;
  }

  if (returnTo.startsWith("/api/auth")) {
    return null;
  }

  return returnTo;
}

export function buildAppRedirectUrl(
  appUrl: string,
  returnTo: string | null | undefined,
) {
  return new URL(getSafeReturnTo(returnTo) || "/", appUrl);
}
