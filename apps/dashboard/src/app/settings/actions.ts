"use server";

import { apiGet, apiPut } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getSettings() {
  return apiGet<any[]>("/settings");
}

export async function getSetting(key: string) {
  const data = await apiGet<{ value: string | null }>(`/settings/${key}`);
  return data.value;
}

export async function setSetting(key: string, value: string) {
  await apiPut(`/settings/${key}`, { value });
  revalidatePath("/settings");
}
