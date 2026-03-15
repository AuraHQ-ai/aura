export const OAUTH_RETURN_TO_COOKIE = "oauth_return_to";
export const OAUTH_PROXY_ORIGIN_COOKIE = "oauth_proxy_origin";

export const PRODUCTION_URL = "https://app.aurahq.ai";

export function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost") return true;
    if (url.hostname.endsWith(".vercel.app")) return true;
    if (url.hostname === "app.aurahq.ai") return true;
    return false;
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
