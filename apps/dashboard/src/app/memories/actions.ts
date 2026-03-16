"use server";

import { apiGet, apiGetOrNull, apiPatch, apiDelete } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getMemories(search?: string, type?: string, page = 1, limit = 100) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (type) params.set("type", type);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(`/memories?${params}`);
}

export async function searchMemoriesKeyword(query: string) {
  return apiGet<{ items: any[]; total: number }>(`/memories?search=${encodeURIComponent(query)}&limit=50`);
}

export async function getMemory(id: string) {
  return apiGetOrNull<any>(`/memories/${id}`);
}

export async function updateMemory(
  id: string,
  data: { content?: string; relevanceScore?: number; shareable?: number },
) {
  await apiPatch(`/memories/${id}`, data);
  revalidatePath("/memories");
  revalidatePath(`/memories/${id}`);
}

export async function deleteMemory(id: string) {
  await apiDelete(`/memories/${id}`);
  revalidatePath("/memories");
}
