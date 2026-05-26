import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  AuthContext,
  getStoredToken,
  storeToken,
  clearToken,
  decodeToken,
  type Session,
} from "@/lib/auth";

async function hydrateSessionRole(session: Session | null, token: string): Promise<Session | null> {
  if (!session) return null;

  try {
    const res = await fetch("/api/dashboard/auth/check-role", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slackUserId: session.slackUserId,
        name: session.name,
        picture: session.picture,
      }),
    });

    if (!res.ok) return null;
    const roleResult = await res.json() as { allowed?: boolean; role?: string };
    if (!roleResult.allowed) return null;
    return { ...session, role: roleResult.role };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for token in URL (OAuth callback redirect)
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      storeToken(urlToken);
      params.delete("token");
      const cleanUrl = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
      decodeToken(urlToken).then((s) => hydrateSessionRole(s, urlToken)).then((s) => {
        if (!s) clearToken();
        setSession(s);
        setLoading(false);
      });
      return;
    }

    const token = getStoredToken();
    if (token) {
      decodeToken(token).then((s) => hydrateSessionRole(s, token)).then((s) => {
        if (!s) clearToken();
        setSession(s);
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  const login = useCallback((token: string) => {
    storeToken(token);
    setLoading(true);
    decodeToken(token).then((s) => hydrateSessionRole(s, token)).then((s) => {
      if (!s) clearToken();
      setSession(s);
      setLoading(false);
    });
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setSession(null);
  }, []);

  return (
    <AuthContext value={{ session, loading, login, logout }}>
      {children}
    </AuthContext>
  );
}
