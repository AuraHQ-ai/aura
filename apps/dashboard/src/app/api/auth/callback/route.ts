import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSession, getSessionCookieName } from "@/lib/auth";
import { isAdmin } from "@/lib/permissions";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const cookieStore = await cookies();
  const savedState = cookieStore.get("oauth_state")?.value;

  if (!code || !state || state !== savedState) {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=invalid_state`);
  }

  cookieStore.delete("oauth_state");

  const tokenRes = await fetch("https://slack.com/api/openid.connect.token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: `${appUrl}/api/auth/callback`,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.ok) {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=token_error`);
  }

  const userInfoRes = await fetch("https://slack.com/api/openid.connect.userInfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userInfo = await userInfoRes.json();
  if (!userInfo.ok) {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=userinfo_error`);
  }

  const slackUserId = userInfo["https://slack.com/user_id"] || userInfo.sub;
  if (!isAdmin(slackUserId)) {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=not_admin`);
  }

  const jwt = await createSession({
    slackUserId,
    name: userInfo.name || "Admin",
    picture: userInfo.picture || "",
  });

  cookieStore.set(getSessionCookieName(), jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });

  return NextResponse.redirect(appUrl);
}
