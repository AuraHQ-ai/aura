import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getAppUrl, getSafeReturnTo, isAllowedOrigin } from "@/lib/auth-redirect";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.searchParams.get("origin");
  const returnTo = getSafeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
  );

  if (!origin || !isAllowedOrigin(origin)) {
    return new NextResponse("Invalid origin", { status: 400 });
  }

  const appUrl = getAppUrl();
  const nonce = crypto.randomBytes(16).toString("hex");

  const cookieStore = await cookies();
  cookieStore.set("oauth_state", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });

  // Encode origin + returnTo + CSRF nonce in the state parameter so they
  // survive the round-trip through Slack without needing cross-deployment
  // cookies or a shared HMAC secret.
  const state = Buffer.from(
    JSON.stringify({ nonce, origin, returnTo }),
  ).toString("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SLACK_CLIENT_ID!,
    scope: "openid profile email",
    redirect_uri: `${appUrl}/api/auth/proxy-callback`,
    state,
    nonce: crypto.randomBytes(16).toString("hex"),
  });

  return NextResponse.redirect(
    `https://slack.com/openid/connect/authorize?${params.toString()}`,
  );
}
