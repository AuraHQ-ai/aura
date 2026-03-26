import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  createSession,
  getSessionCookieName,
  verifyTransferToken,
} from "@/lib/auth";
import type { Session } from "@/lib/auth";
import {
  buildAppRedirectUrl,
  getAppUrl,
  getSafeReturnTo,
  PRODUCTION_URL,
} from "@/lib/auth-redirect";

/**
 * Verify the transfer token locally first (works when the secret matches
 * production, e.g. on production itself or localhost). Falls back to a
 * server-to-server call to production's proxy-verify endpoint so preview
 * deployments work even with a different DASHBOARD_SESSION_SECRET.
 */
async function resolveTransferToken(token: string): Promise<Session> {
  try {
    return await verifyTransferToken(token);
  } catch {
    // Secret mismatch — ask production to verify
  }

  const res = await fetch(`${PRODUCTION_URL}/api/auth/proxy-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    throw new Error("Transfer token verification failed");
  }

  return res.json();
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const returnTo = getSafeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
  );
  const appUrl = getAppUrl();

  if (!token) {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=missing_token`);
  }

  try {
    const session = await resolveTransferToken(token);

    const jwt = await createSession(session);
    const cookieStore = await cookies();
    cookieStore.set(getSessionCookieName(), jwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return NextResponse.redirect(buildAppRedirectUrl(appUrl, returnTo));
  } catch {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=invalid_token`,
    );
  }
}
