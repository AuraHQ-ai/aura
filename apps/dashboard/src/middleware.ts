import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const PUBLIC_PATHS = ["/api/auth", "/unauthorized", "/favicon.ico"];

function getSecret() {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) throw new Error("DASHBOARD_SESSION_SECRET not configured");
  return new TextEncoder().encode(secret);
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get("aura_session")?.value;
  if (!token) {
    const loginUrl = new URL("/api/auth/login", request.url);
    loginUrl.searchParams.set("returnTo", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.purpose) throw new Error("Invalid token type");
    const response = NextResponse.next();
    response.headers.set("x-user-id", payload.slackUserId as string);
    response.headers.set("x-user-name", payload.name as string);
    response.headers.set("x-user-picture", payload.picture as string);
    return response;
  } catch {
    const loginUrl = new URL("/api/auth/login", request.url);
    loginUrl.searchParams.set("returnTo", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
