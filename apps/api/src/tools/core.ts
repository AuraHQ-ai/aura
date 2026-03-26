import type { ScheduleContext } from "@aura/db/schema";
import { createDateTimeTools } from "./datetime.js";
import { createNoteTools } from "./notes.js";
import { createWebTools } from "./web.js";
import { createConversationSearchTools } from "./conversations.js";
import { createResourceTools } from "./resources.js";
import { createHttpRequestTool } from "./http-request.js";
import { createSandboxTools } from "./sandbox.js";
import { createBrowserTools } from "./browser.js";
import { createBigQueryTools } from "./bigquery.js";
import { createCursorAgentTools } from "./cursor-agent.js";
import { createPeopleTools } from "./people.js";
import { createCredentialTools } from "./credentials.js";
import { createEmailTools, createGmailEATools } from "./email.js";
import { createSheetsTools } from "./sheets.js";
import { createDriveTools } from "./drive.js";
import { createVoiceTools } from "./voice.js";
import { createJobTools } from "./jobs.js";
import { createSubagentTools } from "./subagents.js";
import { createScratchpadTools } from "./scratchpad.js";
import { filterToolsByCredentials } from "../lib/tool.js";
import { resolveUserCredentials } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

/**
 * Channel-agnostic tools available to every connector (Slack, Dashboard, etc.).
 *
 * Tools that strictly require a Slack WebClient (lists, tables, email-sync,
 * send_voice_note, inline Slack channel/message ops) live in the Slack connector only.
 *
 * Tools like jobs, subagents, and voice are included here without a WebClient;
 * the Slack connector overwrites them with client-aware versions via spread.
 *
 * Filters tools based on the calling user's credential access.
 */
export async function createCoreTools(context?: ScheduleContext, preResolvedCreds?: Set<string>) {
  const allTools = {
    ...createDateTimeTools(),
    ...createNoteTools(context),
    ...createWebTools(),
    ...createConversationSearchTools(context),
    ...createResourceTools(context),
    ...createHttpRequestTool(context),
    ...createSandboxTools(context),
    ...createBrowserTools(context),
    ...createBigQueryTools(context),
    ...createCursorAgentTools(context),
    ...createPeopleTools(context),
    ...createCredentialTools(context),
    ...createEmailTools(context),
    ...createGmailEATools(context),
    ...createSheetsTools(context),
    ...createDriveTools(context),
    ...createVoiceTools(undefined, context),
    ...createJobTools(undefined, context),
    ...createSubagentTools(undefined, context),
    ...createScratchpadTools(crypto.randomUUID()),
  };

  try {
    const userCreds = preResolvedCreds ?? await resolveUserCredentials(context?.userId);
    return filterToolsByCredentials(allTools, userCreds);
  } catch (e: any) {
    logger.warn("createCoreTools: credential resolution failed, returning ungated tools only", {
      userId: context?.userId,
      error: e.message,
    });
    return filterToolsByCredentials(allTools, new Set());
  }
}
