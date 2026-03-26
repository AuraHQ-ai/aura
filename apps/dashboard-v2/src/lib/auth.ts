import { createContext, useContext } from "react";
import { jwtVerify } from "jose";

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

export function getStoredToken(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function storeToken(token: string) {
  localStorage.setItem(SESSION_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(SESSION_KEY);
}

export async function decodeToken(token: string): Promise<Session | null> {
  try {
    const secret = import.meta.env.VITE_SESSION_SECRET;
    if (secret) {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(secret),
      );
      if (payload.purpose) return null;
      return {
        slackUserId: payload.slackUserId as string,
        name: payload.name as string,
        picture: payload.picture as string,
      };
    }
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!));
    if (payload.purpose) return null;
    return {
      slackUserId: payload.slackUserId as string,
      name: (payload.name as string) || "User",
      picture: (payload.picture as string) || "",
    };
  } catch {
    return null;
  }
}
