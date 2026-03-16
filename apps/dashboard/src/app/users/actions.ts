"use server";

import { apiGet, apiGetOrNull, apiPatch } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getUsers(search?: string, page = 1, limit = 100) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(`/users?${params}`);
}

export async function getUser(slackUserId: string) {
  return apiGetOrNull<any>(`/users/${slackUserId}`);
}

export async function updatePerson(
  personId: string,
  data: { jobTitle?: string; preferredLanguage?: string; gender?: string; notes?: string },
) {
  await apiPatch(`/users/person/${personId}`, data);
  revalidatePath("/users");
}
