const API_URL = process.env.AURA_API_URL || "http://localhost:3001";
const API_SECRET = process.env.DASHBOARD_API_SECRET;

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_SECRET}`,
    "Content-Type": "application/json",
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/api/dashboard${path}`, {
    headers: headers(),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function apiGetOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}/api/dashboard${path}`, {
    headers: headers(),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/dashboard${path}`, {
    method: "POST",
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API POST ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/dashboard${path}`, {
    method: "PATCH",
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API PATCH ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/dashboard${path}`, {
    method: "PUT",
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API PUT ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function apiDelete<T = { ok: boolean }>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/api/dashboard${path}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API DELETE ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}
