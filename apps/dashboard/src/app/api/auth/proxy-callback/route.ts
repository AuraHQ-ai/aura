import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createTransferToken } from "@/lib/auth";
import {
  getSafeReturnTo,
  isAllowedOrigin,
  OAUTH_PROXY_ORIGIN_COOKIE,
  OAUTH_RETURN_TO_COOKIE,
} from "@/lib/auth-redirect";
import { isAdmin } from "@/lib/permissions";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const cookieStore = await cookies();
  const savedState = cookieStore.get("oauth_state")?.value;
  const origin = cookieStore.get(OAUTH_PROXY_ORIGIN_COOKIE)?.value;
  const returnTo = getSafeReturnTo(
    cookieStore.get(OAUTH_RETURN_TO_COOKIE)?.value,
  );

  if (!code || !state || state !== savedState) {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=invalid_state`,
    );
  }

  if (!origin || !isAllowedOrigin(origin)) {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=invalid_origin`,
    );
  }

  cookieStore.delete("oauth_state");
  cookieStore.delete(OAUTH_PROXY_ORIGIN_COOKIE);
  cookieStore.delete(OAUTH_RETURN_TO_COOKIE);

  const tokenRes = await fetch("https://slack.com/api/openid.connect.token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: `${appUrl}/api/auth/proxy-callback`,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.ok) {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=token_error`,
    );
  }

  const userInfoRes = await fetch(
    "https://slack.com/api/openid.connect.userInfo",
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
  );
  const userInfo = await userInfoRes.json();
  if (!userInfo.ok) {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=userinfo_error`,
    );
  }

  const slackUserId = userInfo["https://slack.com/user_id"] || userInfo.sub;
  if (!isAdmin(slackUserId)) {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=not_admin`,
    );
  }

  const transferToken = await createTransferToken({
    slackUserId,
    name: userInfo.name || "Admin",
    picture: userInfo.picture || "",
  });

  const redirectUrl = new URL("/api/auth/token-receive", origin);
  redirectUrl.searchParams.set("token", transferToken);
  if (returnTo) {
    redirectUrl.searchParams.set("returnTo", returnTo);
  }

  return NextResponse.redirect(redirectUrl.toString());
}
