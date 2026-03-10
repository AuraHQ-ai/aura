import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { createSession, getSessionCookieName } from "@/lib/auth";

export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // In local dev, skip Slack OAuth and create a session directly
  if (process.env.NODE_ENV === "development") {
    const adminId = (process.env.AURA_ADMIN_USER_IDS || "").split(",")[0]?.trim();
    const jwt = await createSession({
      slackUserId: adminId || "dev-user",
      name: "Dev Admin",
      picture: "",
    });
    const cookieStore = await cookies();
    cookieStore.set(getSessionCookieName(), jwt, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });
    return NextResponse.redirect(appUrl);
  }

  const state = crypto.randomBytes(16).toString("hex");

  const cookieStore = await cookies();
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
