"use server";

import { apiGet, apiGetOrNull, apiPut } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getSettings() {
  return apiGet<any[]>("/settings");
}

export async function getSetting(key: string) {
  const data = await apiGetOrNull<{ value: string | null }>(`/settings/${key}`);
  return data?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await apiPut(`/settings/${key}`, { value });
  revalidatePath("/settings");
}
