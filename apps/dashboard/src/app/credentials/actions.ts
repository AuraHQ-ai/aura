"use server";

import { apiGet, apiGetOrNull, apiPost, apiPatch, apiDelete } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function getCredentials(
  search?: string,
  page = 1,
  limit = 100,
) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(
    `/credentials?${params}`,
  );
}

export async function getCredential(id: string) {
  return apiGetOrNull<any>(`/credentials/${id}`);
}

export async function createCredential(data: {
  name: string;
  type: string;
  ownerId: string;
  value: string;
  expiresAt?: string;
  tokenUrl?: string;
}) {
  const result = await apiPost<any>("/credentials", data);
  revalidatePath("/credentials");
  return result;
}

export async function updateCredentialValue(id: string, value: string) {
  await apiPatch(`/credentials/${id}/value`, { value });
  revalidatePath(`/credentials/${id}`);
}

export async function grantCredentialAccess(
  credentialId: string,
  granteeId: string,
  permission: string,
  grantedBy: string,
) {
  await apiPost(`/credentials/${credentialId}/grants`, {
    granteeId,
    permission,
    grantedBy,
  });
  revalidatePath(`/credentials/${credentialId}`);
}

export async function revokeCredentialAccess(
  grantId: string,
  credentialId: string,
) {
  await apiDelete(`/credentials/${credentialId}/grants/${grantId}`);
  revalidatePath(`/credentials/${credentialId}`);
}

export async function deleteCredential(id: string) {
  await apiDelete(`/credentials/${id}`);
  revalidatePath("/credentials");
}
