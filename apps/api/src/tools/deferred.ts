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

/**
 * Apply Anthropic's deferred schema loading to infrequently used tools and add
 * the native BM25 search meta-tool that can load their schemas on demand.
 */
export async function applyAnthropicToolDiscovery<T extends Record<string, any>>(
  tools: T,
  modelId?: string,
): Promise<T> {
  if (!isAnthropicModel(modelId)) return tools;

  const mutableTools = tools as Record<string, any>;
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
