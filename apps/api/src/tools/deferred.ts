import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { deferredToolThreadCache } from "@aura/db/schema";
import type { ScheduleContext } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

export interface DeferredToolManifestEntry {
  name: string;
  description: string;
}

export const DEFERRED_TOOL_NAMES = new Set([
  // BigQuery / Data
  "bq_list_datasets",
  "bq_list_tables",
  "bq_inspect_table",
  "bq_execute_query",
  // Google Sheets
  "read_google_sheet",
  // Google Drive
  "search_drive",
  "read_drive_file",
  "list_drive_folder",
  "list_shared_drives",
  // Calendar
  "check_calendar",
  "create_event",
  "update_event",
  "delete_event",
  "find_available_slot",
  // Canvas
  "read_canvas",
  "create_canvas",
  "edit_canvas",
  "delete_canvas",
  "share_canvas",
  "list_canvases",
  // Slack Lists (list + get are eager -- used in every bug triage session)
  "create_slack_list_item",
  "update_slack_list_item",
  "delete_slack_list_item",
  // Email
  "send_email",
  "reply_to_email",
  // Email triage (per-user Gmail)
  "sync_emails",
  "email_digest",
  "update_email_thread",
  "read_user_emails",
  "read_user_email",
  "generate_gmail_auth_url",
  "create_gmail_draft",
  "list_gmail_drafts",
  "delete_gmail_draft",
  // Dev / Code (run_command is eager -- used reflexively in most sessions)
  "dispatch_headless",
  "read_job_trace",
  "dispatch_cursor_agent",
  "check_cursor_agent",
  "followup_cursor_agent",
  "stop_cursor_agent",
  "get_cursor_conversation",
  "list_cursor_agents",
  // Browser
  "browse",
  "download_slack_file",
  // Voice / Calls
  "list_voice_agents",
  "place_call",
  "send_sms",
  "send_voice_note",
  // Directory / Contacts
  "lookup_workspace_user",
  "list_workspace_users",
  "lookup_contact",
  // Checkpoint
  "checkpoint_plan",
  // Resources
  "ingest_resource",
  "search_resources",
  "get_resource",
  "list_resources",
  // Subagent
  "run_subagent",
  // People
  "get_person",
  "update_person",
]);

function isAnthropicModel(modelId?: string): boolean {
  return modelId?.startsWith("anthropic/") ?? false;
}

function toOneLineDescription(description: unknown): string {
  if (typeof description !== "string") return "deferred tool";
  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) return "deferred tool";

  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  const withoutTerminalPunctuation = firstSentence.replace(/[.!?]$/, "");
  return withoutTerminalPunctuation.length > 180
    ? `${withoutTerminalPunctuation.slice(0, 177)}...`
    : withoutTerminalPunctuation;
}

function hasDeferredLoading(tool: unknown): boolean {
  return Boolean(
    tool &&
      typeof tool === "object" &&
      (tool as { providerOptions?: { anthropic?: { deferLoading?: boolean } } })
        .providerOptions?.anthropic?.deferLoading === true,
  );
}

function getThreadCacheKey(context?: ScheduleContext): {
  workspaceId: string;
  channelId: string;
  threadTs: string;
} | null {
  if (!context?.channelId || !context.threadTs) return null;
  return {
    workspaceId: context.workspaceId ?? "default",
    channelId: context.channelId,
    threadTs: context.threadTs,
  };
}

function withoutDeferredLoading(tool: any): any {
  if (!tool || typeof tool !== "object") return tool;
  const providerOptions = tool.providerOptions ?? {};
  const anthropicOptions = providerOptions.anthropic ?? {};
  const { deferLoading: _deferLoading, ...restAnthropicOptions } = anthropicOptions;
  return {
    ...tool,
    providerOptions: {
      ...providerOptions,
      anthropic: restAnthropicOptions,
    },
  };
}

export async function getCachedDeferredToolNames(
  context?: ScheduleContext,
): Promise<Set<string>> {
  const key = getThreadCacheKey(context);
  if (!key) return new Set();

  try {
    const rows = await db
      .select({ toolName: deferredToolThreadCache.toolName })
      .from(deferredToolThreadCache)
      .where(
        and(
          eq(deferredToolThreadCache.workspaceId, key.workspaceId),
          eq(deferredToolThreadCache.channelId, key.channelId),
          eq(deferredToolThreadCache.threadTs, key.threadTs),
        ),
      );
    return new Set(rows.map((row) => row.toolName));
  } catch (error: any) {
    logger.warn("Failed to read deferred tool thread cache", {
      error: error?.message,
      channelId: key.channelId,
      threadTs: key.threadTs,
    });
    return new Set();
  }
}

export async function cacheDeferredToolResolutions(
  context: ScheduleContext | undefined,
  toolNames: Iterable<string>,
): Promise<void> {
  const key = getThreadCacheKey(context);
  if (!key) return;

  const names = [...new Set([...toolNames].filter((name) => DEFERRED_TOOL_NAMES.has(name)))];
  if (names.length === 0) return;

  try {
    await db
      .insert(deferredToolThreadCache)
      .values(
        names.map((toolName) => ({
          workspaceId: key.workspaceId,
          channelId: key.channelId,
          threadTs: key.threadTs,
          toolName,
          resolvedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [
          deferredToolThreadCache.workspaceId,
          deferredToolThreadCache.channelId,
          deferredToolThreadCache.threadTs,
          deferredToolThreadCache.toolName,
        ],
        set: { resolvedAt: new Date() },
      });
    logger.info("Cached deferred tool schemas for thread", {
      channelId: key.channelId,
      threadTs: key.threadTs,
      toolNames: names,
    });
  } catch (error: any) {
    logger.warn("Failed to write deferred tool thread cache", {
      error: error?.message,
      channelId: key.channelId,
      threadTs: key.threadTs,
      toolNames: names,
    });
  }
}

/**
 * Apply Anthropic's deferred schema loading to infrequently used tools and add
 * the native BM25 search meta-tool that can load their schemas on demand.
 */
export async function applyAnthropicToolDiscovery<T extends Record<string, any>>(
  tools: T,
  modelId?: string,
  context?: ScheduleContext,
): Promise<T> {
  if (!isAnthropicModel(modelId)) return tools;

  const mutableTools = tools as Record<string, any>;
  const cachedDeferredTools = await getCachedDeferredToolNames(context);
  const { anthropic } = await import("@ai-sdk/anthropic");
  // toolSearchBm25_20251119() returns an Anthropic-native tool object that
  // bypasses defineTool(), so attach the Slack metadata manually.
  const toolSearch = anthropic.tools.toolSearchBm25_20251119();
  ((toolSearch as unknown) as Record<string, unknown>).slack = {
    status: "Searching tools...",
    detail: (i: { query: string }) => i.query,
  };
  mutableTools.toolSearch = toolSearch;

  for (const name of DEFERRED_TOOL_NAMES) {
    const existing = mutableTools[name];
    if (!existing) continue;
    if (cachedDeferredTools.has(name)) {
      mutableTools[name] = withoutDeferredLoading(existing);
      continue;
    }
    const providerOptions =
      existing && typeof existing === "object" && "providerOptions" in existing
        ? (existing as { providerOptions?: Record<string, any> }).providerOptions ?? {}
        : {};
    mutableTools[name] = {
      ...existing,
      providerOptions: {
        ...providerOptions,
        anthropic: {
          ...(providerOptions.anthropic ?? {}),
          deferLoading: true,
        },
      },
    };
  }

  return tools;
}

export function getDeferredToolManifest(
  tools: Record<string, unknown>,
): DeferredToolManifestEntry[] {
  return Object.entries(tools)
    .filter(([, tool]) => hasDeferredLoading(tool))
    .map(([name, tool]) => ({
      name,
      description: toOneLineDescription(
        (tool as { description?: unknown }).description,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
