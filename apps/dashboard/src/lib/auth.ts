import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "aura_session";

export interface Session {
  slackUserId: string;
  name: string;
  picture: string;
}

function getSecret() {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) throw new Error("DASHBOARD_SESSION_SECRET is not configured");
  return new TextEncoder().encode(secret);
}

export async function createSession(payload: Session): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function getSession(): Promise<Session | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return null;

    const { payload } = await jwtVerify(token, getSecret());
    return {
      slackUserId: payload.slackUserId as string,
      name: payload.name as string,
      picture: payload.picture as string,
    };
  } catch {
    return null;
  }
}

export function getSessionCookieName() {
  return COOKIE_NAME;
}
