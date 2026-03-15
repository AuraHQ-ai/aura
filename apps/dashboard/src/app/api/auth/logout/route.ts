import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSessionCookieName } from "@/lib/auth";
import { getAppUrl } from "@/lib/auth-redirect";

export async function GET() {
  const cookieStore = await cookies();
  cookieStore.delete(getSessionCookieName());

  const appUrl = getAppUrl();
  return NextResponse.redirect(`${appUrl}/api/auth/login`);
}
