import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  clearToken,
  decodeSession,
  storeToken,
  type Session,
} from "@/lib/auth";

interface AuthContextValue {
  session: Session | null;
  isLoading: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    decodeSession().then((s) => {
      setSession(s);
      setIsLoading(false);
    });
  }, []);

  const login = useCallback((token: string) => {
    storeToken(token);
    decodeSession().then(setSession);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setSession(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
