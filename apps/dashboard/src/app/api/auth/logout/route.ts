import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSessionCookieName } from "@/lib/auth";

export async function GET() {
  const cookieStore = await cookies();
  cookieStore.delete(getSessionCookieName());

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return NextResponse.redirect(`${appUrl}/api/auth/login`);
}
