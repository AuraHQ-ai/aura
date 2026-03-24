import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSession, getSessionCookieName } from "@/lib/auth";
import {
  buildAppRedirectUrl,
  getAppUrl,
  getSafeReturnTo,
  OAUTH_RETURN_TO_COOKIE,
} from "@/lib/auth-redirect";
import { checkRole } from "@/lib/auth-check";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const appUrl = getAppUrl();

  const cookieStore = await cookies();
  const savedState = cookieStore.get("oauth_state")?.value;
  const returnTo = getSafeReturnTo(
    cookieStore.get(OAUTH_RETURN_TO_COOKIE)?.value,
  );

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
  const name = userInfo.name || "Admin";
  const picture = userInfo.picture || "";

  let roleResult;
  try {
    roleResult = await checkRole({ slackUserId, name, picture });
  } catch {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=check_failed`);
  }
  if (!roleResult.allowed) {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=not_admin`);
  }

  const jwt = await createSession({ slackUserId, name, picture });

  cookieStore.set(getSessionCookieName(), jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });
  cookieStore.delete(OAUTH_RETURN_TO_COOKIE);

  return NextResponse.redirect(buildAppRedirectUrl(appUrl, returnTo));
}
