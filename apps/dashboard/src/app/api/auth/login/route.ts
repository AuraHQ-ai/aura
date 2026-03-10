import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";

export async function GET() {
  const state = crypto.randomBytes(16).toString("hex");

  const cookieStore = await cookies();
  cookieStore.set("oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
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
