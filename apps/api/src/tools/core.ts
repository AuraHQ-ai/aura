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
import { filterToolsByCredentials } from "../lib/tool.js";
import { resolveUserCredentials } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

/**
 * Channel-agnostic tools available to every connector (Slack, Dashboard, etc.).
 *
 * Tools that require a Slack WebClient (jobs, lists, tables, subagents, voice,
 * email-sync) are NOT included here -- they live in the Slack connector only.
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
  };

  try {
    const userCreds = preResolvedCreds ?? await resolveUserCredentials(context?.userId);
    return filterToolsByCredentials(allTools, userCreds);
  } catch (e: any) {
    logger.warn("createCoreTools: credential resolution failed, returning all tools", {
      userId: context?.userId,
      error: e.message,
    });
    return allTools;
  }
}
