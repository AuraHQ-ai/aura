"use server";

import { apiGet, apiGetOrNull, apiPatch } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getErrors(resolved?: string, search?: string, page = 1, limit = 100) {
  const params = new URLSearchParams();
  if (resolved) params.set("resolved", resolved);
  if (search) params.set("search", search);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(`/errors?${params}`);
}

export async function getError(id: string) {
  return apiGetOrNull<any>(`/errors/${id}`);
}

export async function resolveErrors(ids: string[]) {
  if (ids.length === 0) return;
  await apiPatch("/errors", { ids });
  revalidatePath("/errors");
}
