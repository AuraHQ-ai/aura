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
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get("aura_session")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/api/auth/login", request.url));
  }

  try {
    const { payload } = await jwtVerify(token, getSecret());
    const response = NextResponse.next();
    response.headers.set("x-user-id", payload.slackUserId as string);
    response.headers.set("x-user-name", payload.name as string);
    response.headers.set("x-user-picture", payload.picture as string);
    return response;
  } catch {
    return NextResponse.redirect(new URL("/api/auth/login", request.url));
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
