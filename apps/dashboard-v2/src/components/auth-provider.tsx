import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  AuthContext,
  getStoredToken,
  storeToken,
  clearToken,
  decodeToken,
  type Session,
} from "@/lib/auth";

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
      decodeToken(urlToken).then((s) => {
        setSession(s);
        setLoading(false);
      });
      return;
    }

    const token = getStoredToken();
    if (token) {
      decodeToken(token).then((s) => {
        setSession(s);
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  const login = useCallback((token: string) => {
    storeToken(token);
    decodeToken(token).then((s) => {
      setSession(s);
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
