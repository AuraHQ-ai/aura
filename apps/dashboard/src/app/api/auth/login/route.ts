import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import {
  getSafeReturnTo,
  OAUTH_RETURN_TO_COOKIE,
  PRODUCTION_URL,
} from "@/lib/auth-redirect";

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const returnTo = getSafeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  // Non-production environments delegate to production's OAuth proxy
  const isProduction = new URL(appUrl).origin === PRODUCTION_URL;
  if (!isProduction) {
    const proxyUrl = new URL(`${PRODUCTION_URL}/api/auth/proxy-login`);
    proxyUrl.searchParams.set("origin", appUrl);
    if (returnTo) proxyUrl.searchParams.set("returnTo", returnTo);
    return NextResponse.redirect(proxyUrl.toString());
  }

  const cookieStore = await cookies();

  if (returnTo) {
    cookieStore.set(OAUTH_RETURN_TO_COOKIE, returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 300,
      path: "/",
    });
  } else {
    cookieStore.delete(OAUTH_RETURN_TO_COOKIE);
  }

  const state = crypto.randomBytes(16).toString("hex");
  cookieStore.set("oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SLACK_CLIENT_ID!,
    scope: "openid profile email",
    redirect_uri: `${appUrl}/api/auth/callback`,
    state,
    nonce: crypto.randomBytes(16).toString("hex"),
  });

  return NextResponse.redirect(
    `https://slack.com/openid/connect/authorize?${params.toString()}`,
  );
}
