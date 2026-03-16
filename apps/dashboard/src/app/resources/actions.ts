"use server";

import { apiGet, apiGetOrNull, apiDelete } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getResources(
  source?: string,
  status?: string,
  search?: string,
  page = 1,
  limit = 100,
) {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(
    `/resources?${params}`,
  );
}

export async function getResource(id: string) {
  return apiGetOrNull<any>(`/resources/${id}`);
}

export async function deleteResource(id: string) {
  await apiDelete(`/resources/${id}`);
  revalidatePath("/resources");
}
