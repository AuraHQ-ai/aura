import createClient from "openapi-fetch";
import type { paths } from "./api-types";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export const api = createClient<paths>({
  baseUrl: `${API_URL}/api/dashboard`,
  headers: {
    Authorization: `Bearer ${import.meta.env.VITE_API_SECRET}`,
  },
});

function headers(): Record<string, string> {
  const token = localStorage.getItem("aura_session");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
  } else if (import.meta.env.VITE_API_SECRET) {
    h["Authorization"] = `Bearer ${import.meta.env.VITE_API_SECRET}`;
  }
  return h;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/api/dashboard${path}`, {
    headers: headers(),
  });
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
