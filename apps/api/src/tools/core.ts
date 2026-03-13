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

/**
 * Channel-agnostic tools available to every connector (Slack, Dashboard, etc.).
 *
 * Tools that require a Slack WebClient (jobs, lists, tables, subagents, voice,
 * email-sync) are NOT included here -- they live in the Slack connector only.
 */
export function createCoreTools(context?: ScheduleContext) {
  return {
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
}
