import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  createSession,
  getSessionCookieName,
  verifyTransferToken,
} from "@/lib/auth";
import { buildAppRedirectUrl, getSafeReturnTo } from "@/lib/auth-redirect";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const returnTo = getSafeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
  );
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (!token) {
    return NextResponse.redirect(`${appUrl}/unauthorized?reason=missing_token`);
  }

  try {
    const session = await verifyTransferToken(token);

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
