import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import {
  getSafeReturnTo,
  isAllowedOrigin,
  verifyOriginSignature,
  OAUTH_PROXY_ORIGIN_COOKIE,
  OAUTH_RETURN_TO_COOKIE,
} from "@/lib/auth-redirect";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.searchParams.get("origin");
  const sig = request.nextUrl.searchParams.get("sig");
  const returnTo = getSafeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
  );

  if (!origin || !isAllowedOrigin(origin)) {
    return new NextResponse("Invalid origin", { status: 400 });
  }

  if (!sig || !verifyOriginSignature(origin, sig)) {
    return new NextResponse("Invalid origin signature", { status: 403 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const cookieStore = await cookies();

  cookieStore.set(OAUTH_PROXY_ORIGIN_COOKIE, origin, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });

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
    redirect_uri: `${appUrl}/api/auth/proxy-callback`,
    state,
    nonce: crypto.randomBytes(16).toString("hex"),
  });

  return NextResponse.redirect(
    `https://slack.com/openid/connect/authorize?${params.toString()}`,
  );
}
