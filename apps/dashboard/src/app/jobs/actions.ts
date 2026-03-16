"use server";

import { apiGet, apiGetOrNull, apiPatch } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getJobs(search?: string, page = 1, limit = 100) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(`/jobs?${params}`);
}

export async function getJob(id: string) {
  return apiGetOrNull<any>(`/jobs/${id}`);
}

export async function toggleJobEnabled(id: string, enabled: boolean) {
  await apiPatch(`/jobs/${id}`, { enabled });
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
}
