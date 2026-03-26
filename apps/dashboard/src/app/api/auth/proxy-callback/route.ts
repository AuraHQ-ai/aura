import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createTransferToken } from "@/lib/auth";
import { getAppUrl, getSafeReturnTo, isAllowedOrigin } from "@/lib/auth-redirect";
import { checkRole } from "@/lib/auth-check";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const appUrl = getAppUrl();

  const cookieStore = await cookies();
  const savedNonce = cookieStore.get("oauth_state")?.value;

  let nonce: string | undefined;
  let origin: string | undefined;
  let returnTo: string | null = null;

  try {
    const decoded = JSON.parse(
      Buffer.from(stateParam || "", "base64url").toString(),
    );
    nonce = decoded.nonce;
    origin = decoded.origin;
    returnTo = getSafeReturnTo(decoded.returnTo);
  } catch {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=invalid_state`,
    );
  }

  if (!code || !nonce || nonce !== savedNonce) {
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
  const name = userInfo.name || "Admin";
  const picture = userInfo.picture || "";

  let roleResult;
  try {
    roleResult = await checkRole({ slackUserId, name, picture });
  } catch {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=check_failed`,
    );
  }
  if (!roleResult.allowed) {
    return NextResponse.redirect(
      `${appUrl}/unauthorized?reason=not_admin`,
    );
  }

  const transferToken = await createTransferToken({
    slackUserId,
    name,
    picture,
  });

  const redirectUrl = new URL("/api/auth/token-receive", origin);
  redirectUrl.searchParams.set("token", transferToken);
  if (returnTo) {
    redirectUrl.searchParams.set("returnTo", returnTo);
  }

  return NextResponse.redirect(redirectUrl.toString());
}
