"use server";

import { apiGet, apiGetOrNull, apiPost, apiPatch, apiDelete } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getNotes(search?: string, category?: string, page = 1, limit = 100) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (category) params.set("category", category);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(`/notes?${params}`);
}

export async function getNote(id: string) {
  return apiGetOrNull<any>(`/notes/${id}`);
}

export async function createNote(data: { topic: string; content: string; category: string; expiresAt?: string }) {
  const note = await apiPost<any>("/notes", data);
  revalidatePath("/notes");
  return note;
}

export async function updateNote(id: string, data: { topic?: string; content?: string; category?: string; expiresAt?: string | null }) {
  await apiPatch(`/notes/${id}`, data);
  revalidatePath("/notes");
  revalidatePath(`/notes/${id}`);
}

export async function deleteNote(id: string) {
  await apiDelete(`/notes/${id}`);
  revalidatePath("/notes");
}
