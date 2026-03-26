import createClient from "openapi-fetch";
import type { paths } from "./api-types";

function getAuthToken(): string | null {
  return localStorage.getItem("aura_session");
}

export const api = createClient<paths>({
  baseUrl: "/api/dashboard",
});

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const token = getAuthToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/dashboard${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>("GET", path);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>("POST", path, body);
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>("PATCH", path, body);
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>("PUT", path, body);
}

export async function apiDelete<T = { ok: boolean }>(path: string): Promise<T> {
  return apiFetch<T>("DELETE", path);
}
