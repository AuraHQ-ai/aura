import { createContext, useContext } from "react";

export interface Session {
  slackUserId: string;
  name: string;
  picture: string;
}

export interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  login: (token: string) => void;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

const SESSION_KEY = "aura_session";

export type AuthRedirectReason = "token_expired" | "unauthorized" | "invalid_session";

export function getStoredToken(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function storeToken(token: string) {
  localStorage.setItem(SESSION_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(SESSION_KEY);
}

function getCurrentReturnTo(): string {
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return window.location.pathname === "/login" ? "/" : path;
}

export function getSlackLoginUrl(returnTo = getCurrentReturnTo()): string {
  const params = new URLSearchParams({
    returnTo,
    origin: window.location.origin,
  });
  return `/api/dashboard/auth/login?${params.toString()}`;
}

export function redirectToSlackLogin(reason: AuthRedirectReason = "unauthorized") {
  clearToken();
  const returnTo = getCurrentReturnTo();
  const params = new URLSearchParams({
    reason,
    returnTo,
  });

  window.location.href = `/login?${params.toString()}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const payload = parts[1]!;
  const normalized = payload
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payload.length / 4) * 4, "=");

  return JSON.parse(atob(normalized)) as Record<string, unknown>;
}

export async function decodeToken(token: string): Promise<Session | null> {
  try {
    const payload = decodeJwtPayload(token);
    if (!payload) return null;
    if (payload.purpose) return null;
    if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
      return null;
    }
    return {
      slackUserId: payload.slackUserId as string,
      name: (payload.name as string) || "User",
      picture: (payload.picture as string) || "",
    };
  } catch {
    return null;
  }
}
