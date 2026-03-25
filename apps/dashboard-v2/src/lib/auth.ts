import * as jose from "jose";

const TOKEN_KEY = "aura_session";

export interface Session {
  slackUserId: string;
  name: string;
  picture: string;
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function decodeSession(): Promise<Session | null> {
  const token = getStoredToken();
  if (!token) return null;

  try {
    const claims = jose.decodeJwt(token);

    if (claims.exp && claims.exp * 1000 < Date.now()) {
      clearToken();
      return null;
    }

    return {
      slackUserId: claims.slackUserId as string,
      name: claims.name as string,
      picture: claims.picture as string,
    };
  } catch {
    clearToken();
    return null;
  }
}
