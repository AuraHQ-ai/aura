import { lookup } from "node:dns/promises";

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Returns true if the URL resolves to a private/internal network address.
 * Fails closed: if DNS lookup fails, the URL is considered private (blocked).
 */
export async function isPrivateUrl(url: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return true;
  }

  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (
    bare === "localhost" ||
    bare === "0.0.0.0" ||
    bare === "::1" ||
    bare.endsWith(".local") ||
    bare.endsWith(".internal")
  ) {
    return true;
  }

  let address: string;
  let family: number;
  try {
    ({ address, family } = await lookup(bare));
  } catch {
    return true;
  }

  if (family === 6) {
    const v4Mapped = address.match(
      /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
    );
    if (v4Mapped) {
      address = v4Mapped[1];
    } else {
      if (address === "::1") return true;
      const firstWord = parseInt(address.split(":")[0], 16);
      if (firstWord >= 0xfe80 && firstWord <= 0xfebf) return true;
      if (
        address.toLowerCase().startsWith("fc") ||
        address.toLowerCase().startsWith("fd")
      ) {
        return true;
      }
      return false;
    }
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}
