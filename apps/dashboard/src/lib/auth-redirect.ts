import crypto from "node:crypto";

export const OAUTH_RETURN_TO_COOKIE = "oauth_return_to";
export const OAUTH_PROXY_ORIGIN_COOKIE = "oauth_proxy_origin";

export const PRODUCTION_URL = "https://app.aurahq.ai";

function getProxySecret(): Buffer {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) throw new Error("DASHBOARD_SESSION_SECRET is not configured");
  return Buffer.from(secret, "utf-8");
}

export function signOrigin(origin: string): string {
  return crypto
    .createHmac("sha256", getProxySecret())
    .update(origin)
    .digest("hex");
}

export function verifyOriginSignature(origin: string, sig: string): boolean {
  const expected = signOrigin(origin);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/** Basic sanity check — real trust comes from the HMAC signature. */
export function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost")
      return url.protocol === "http:" || url.protocol === "https:";
    return url.protocol === "https:";
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
