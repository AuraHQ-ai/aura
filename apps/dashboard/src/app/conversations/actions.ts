"use server";

import { apiGet } from "@/lib/api";

export interface ThreadRow {
  channelId: string;
  threadTs: string;
  traceCount: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  firstTraceAt: Date;
  lastTraceAt: Date;
  userId: string | null;
  resolvedName: string | null;
  messagePreview: string | null;
  firstTraceId: string;
  sourceType: string;
}

export async function getConversations(
  sourceType?: string,
  search?: string,
  page = 1,
  limit = 25,
) {
  const params = new URLSearchParams();
  if (sourceType) params.set("sourceType", sourceType);
  if (search) params.set("search", search);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: any[]; total: number }>(
    `/conversations?${params}`,
  );
}

export async function getThreads(
  sourceType?: string,
  search?: string,
  page = 1,
  limit = 25,
) {
  const params = new URLSearchParams();
  if (sourceType) params.set("sourceType", sourceType);
  if (search) params.set("search", search);
  params.set("page", String(page));
  params.set("limit", String(limit));
  return apiGet<{ items: ThreadRow[]; total: number }>(
    `/conversations/threads?${params}`,
  );
}

export async function getConversation(id: string) {
  return apiGet<any>(`/conversations/${id}`);
}

export async function getThreadTraces(
  channelId: string,
  threadTs: string,
) {
  return apiGet<any>(
    `/conversations/threads/${encodeURIComponent(channelId)}/${encodeURIComponent(threadTs)}`,
  );
}
