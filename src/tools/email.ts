import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { resolveSlackUserId, resolveEffectiveUserId } from "../lib/resolve-user.js";
import type { ScheduleContext } from "../db/schema.js";

const AURA_BOT_USER_ID = "U0AFEC1C69F";

// ── Tool Definitions ────────────────────────────────────────────────────────

/**
 * Create email tools for the AI SDK.
 * Uses dynamic import for gmail.js to avoid loading googleapis on every request.
 */
export function createEmailTools(context?: ScheduleContext) {
  return {
    send_email: defineTool({
      description:
        "Send an email. Defaults to sending from aura@realadvisor.com. Set user_name to send from another user's account (requires that user's OAuth access, and caller must be that user or an admin). Use for external communication, follow-ups, outreach, and reports. Never send emails without being asked or having a clear reason (job, follow-up, etc.). Body is sent as plain text — keep it professional but conversational, same tone as Slack. DM privacy applies: don't email someone's private Slack DM content to others. Supports optional file attachments (base64-encoded).",
      inputSchema: z.object({
        to: z.string().describe("Recipient email address"),
        subject: z.string().describe("Email subject line"),
        body: z.string().describe("Email body text"),
        cc: z.string().optional().describe("CC email address"),
        bcc: z.string().optional().describe("BCC email address"),
        reply_to_message_id: z
          .string()
          .optional()
          .describe("Message ID to reply to (for threading)"),
        thread_id: z
          .string()
          .optional()
          .describe("Thread ID for reply threading"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Send from this user's account instead of Aura. The display name, real name, or username, e.g. 'Joan' or '@joan'. Omit to send from aura@realadvisor.com.",
          ),
        attachments: z
          .array(
            z.object({
              filename: z.string().describe("Filename with extension, e.g. 'contract.pdf'"),
              mimeType: z.string().describe("MIME type, e.g. 'application/pdf'"),
              content: z.string().describe("Base64-encoded file content"),
            }),
          )
          .optional()
          .describe("File attachments (base64-encoded)"),
      }),
      execute: async ({
        to,
        subject,
        body,
        cc,
        bcc,
        reply_to_message_id,
        thread_id,
        user_name,
        attachments,
      }) => {
        try {
          let resolvedUserId: string = process.env.AURA_BOT_USER_ID || AURA_BOT_USER_ID;

          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
              };
            }
            resolvedUserId = userId;
          }

          if (user_name) {
            const callerId = context?.userId;
            if (!callerId || (callerId !== resolvedUserId && !isAdmin(callerId))) {
              return { ok: false, error: "You can only send email from your own account. Ask an admin for help." };
            }
          }

          const { sendEmail } = await import("../lib/gmail.js");
          const result = await sendEmail(to, subject, body, {
            cc,
            bcc,
            replyToMessageId: reply_to_message_id,
            threadId: thread_id,
            attachments,
          }, resolvedUserId);

          if (!result) {
            return { ok: false, error: `Failed to send email: no Gmail access for the resolved user. They may need to authorize Aura via OAuth first.` };
          }

          logger.info("send_email tool called", {
            to,
            subject,
            userId: resolvedUserId,
            messageId: result.id,
          });

          return {
            ok: true,
            message: `Email sent to ${to}`,
            id: result.id,
            threadId: result.threadId,
          };
        } catch (error: any) {
          logger.error("send_email tool failed", {
            to,
            subject,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to send email: ${error.message}`,
          };
        }
      },
      slack: { status: "Sending email...", detail: (i) => i.to },
    }),

    reply_to_email: defineTool({
      description: "Reply to an existing email thread. Defaults to replying from aura@realadvisor.com. Set user_name to reply from another user's account (requires that user's OAuth access, and caller must be that user or an admin). Requires message_id and thread_id from read_user_emails or read_user_email.",
      inputSchema: z.object({
        message_id: z
          .string()
          .describe("Message ID of the email to reply to"),
        thread_id: z
          .string()
          .describe("Thread ID for proper threading"),
        body: z.string().describe("Reply body text"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Reply from this user's account instead of Aura. The display name, real name, or username, e.g. 'Joan' or '@joan'. Omit to reply from aura@realadvisor.com.",
          ),
      }),
      execute: async ({ message_id, thread_id, body, user_name }) => {
        try {
          let resolvedUserId: string = process.env.AURA_BOT_USER_ID || AURA_BOT_USER_ID;

          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
              };
            }
            resolvedUserId = userId;
          }

          if (user_name) {
            const callerId = context?.userId;
            if (!callerId || (callerId !== resolvedUserId && !isAdmin(callerId))) {
              return { ok: false, error: "You can only reply from your own email account. Ask an admin for help." };
            }
          }

          const { replyToEmail } = await import("../lib/gmail.js");
          const result = await replyToEmail(message_id, thread_id, body, resolvedUserId);

          if (!result) {
            return { ok: false, error: "Failed to reply to email: no Gmail access for the resolved user. They may need to authorize Aura via OAuth first." };
          }

          logger.info("reply_to_email tool called", {
            originalMessageId: message_id,
            userId: resolvedUserId,
            replyId: result.id,
          });

          return {
            ok: true,
            message: "Reply sent",
            id: result.id,
            threadId: result.threadId,
          };
        } catch (error: any) {
          logger.error("reply_to_email tool failed", {
            messageId: message_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to reply to email: ${error.message}`,
          };
        }
      },
      slack: { status: "Replying to email..." },
    }),

    // ── Workspace Directory Tools ───────────────────────────────────────────

    lookup_workspace_user: defineTool({
      description:
        "Look up a person in the Google Workspace directory by name or email. Returns their email, title, department, and other org info. Use this to find someone's email address before sending them an email.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Name or email to search for, e.g. 'Joan Rodriguez' or 'joan@realadvisor.com'"
          ),
      }),
      execute: async ({ query }) => {
        try {
          const { searchDirectoryUser } = await import(
            "../lib/workspace-directory.js"
          );
          const users = await searchDirectoryUser(query);
          if (!users) {
            return {
              ok: false,
              error:
                "Workspace Directory is not configured or the API returned an error. The OAuth token may need the directory.readonly scope.",
            };
          }

          if (users.length === 0) {
            return {
              ok: true,
              message: `No users found matching "${query}"`,
              users: [],
            };
          }

          logger.info("lookup_workspace_user tool called", {
            query,
            resultCount: users.length,
          });

          return {
            ok: true,
            users: users.map((u) => ({
              email: u.email,
              name: u.name,
              title: u.title || undefined,
              department: u.department || undefined,
            })),
          };
        } catch (error: any) {
          logger.error("lookup_workspace_user failed", {
            query,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to search directory: ${error.message}`,
          };
        }
      },
      slack: { status: "Looking up user...", detail: (i) => i.query },
    }),

    list_workspace_users: defineTool({
      description:
        "List all users in the Google Workspace directory. Returns emails, names, titles, and departments for everyone in the organization.",
      inputSchema: z.object({
        max_results: z
          .number()
          .optional()
          .default(100)
          .describe("Maximum number of users to return (default 100)"),
      }),
      execute: async ({ max_results }) => {
        try {
          const { listDirectoryUsers } = await import(
            "../lib/workspace-directory.js"
          );
          const users = await listDirectoryUsers(max_results);
          if (!users) {
            return {
              ok: false,
              error:
                "Workspace Directory is not configured or the API returned an error.",
            };
          }

          logger.info("list_workspace_users tool called", {
            resultCount: users.length,
          });

          return {
            ok: true,
            count: users.length,
            users: users.map((u) => ({
                email: u.email,
                name: u.name,
                title: u.title || undefined,
                department: u.department || undefined,
              })),
          };
        } catch (error: any) {
          logger.error("list_workspace_users failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list directory users: ${error.message}`,
          };
        }
      },
      slack: { status: "Listing workspace users..." },
    }),

    // ── Contact Lookup ──────────────────────────────────────────────────────

    lookup_contact: defineTool({
      description:
        "Search for external contacts (agents, clients, partners) by name or email. Searches the RealAdvisor platform (3M+ users) and Close CRM (216K sales contacts across CH, ES, FR, IT). Returns name, email, phone, company, and source.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Name or email to search for, e.g. 'Rahel Thoma' or 'trewim.ch'"
          ),
      }),
      execute: async ({ query }) => {
        try {
          const { lookupContact } = await import(
            "../lib/contact-lookup.js"
          );
          const contacts = await lookupContact(query);
          return {
            ok: true,
            count: contacts.length,
            contacts,
          };
        } catch (error: any) {
          logger.error("lookup_contact failed", {
            query,
            error: error.message,
          });
          return {
            ok: false,
            error: `Contact lookup failed: ${error.message}`,
          };
        }
      },
      slack: { status: "Looking up contact...", detail: (i) => i.query },
    }),

    // ── Calendar Tools ──────────────────────────────────────────────────────

    check_calendar: defineTool({
      description:
        "List upcoming calendar events. Defaults to the caller's account. Set user_name to access another user's calendar (requires their OAuth access). Use calendar_id to check a specific calendar (e.g. a colleague's calendar via your own token).",
      inputSchema: z.object({
        time_min: z
          .string()
          .optional()
          .describe(
            "Start of time range (ISO 8601). Defaults to now."
          ),
        time_max: z
          .string()
          .optional()
          .describe(
            "End of time range (ISO 8601). E.g. '2026-02-28T23:59:59Z'"
          ),
        max_results: z
          .number()
          .optional()
          .default(20)
          .describe("Maximum events to return (default 20)"),
        query: z
          .string()
          .optional()
          .describe("Free-text search to filter events"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access another user's calendar instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
        calendar_id: z
          .string()
          .optional()
          .describe(
            "Specific calendar ID to query, e.g. 'joan@realadvisor.com'. Lets you check another person's calendar using your own OAuth token. Defaults to 'primary'.",
          ),
      }),
      execute: async ({ time_min, time_max, max_results, query, user_name, calendar_id }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const { listEvents } = await import("../lib/calendar.js");
          const events = await listEvents({
            calendarId: calendar_id || undefined,
            timeMin: time_min,
            timeMax: time_max,
            maxResults: max_results,
            query: query || undefined,
          }, resolvedUserId);
          if (!events) {
            return {
              ok: false,
              error: user_name
                ? `No calendar access for '${user_name}'. They may need to authorize Aura via OAuth first.`
                : context?.userId
                  ? "You need to connect your Google account first. Ask me to generate an auth link."
                  : "Calendar is not configured. The OAuth token may need calendar scopes.",
            };
          }
          return { ok: true, count: events.length, events };
        } catch (error: any) {
          logger.error("check_calendar failed", { error: error.message });
          return {
            ok: false,
            error: `Calendar query failed: ${error.message}`,
          };
        }
      },
      slack: { status: "Checking calendar...", output: (r) => r.ok === false ? r.error : `${r.events?.length ?? r.count ?? 0} events` },
    }),

    create_event: defineTool({
      description:
        "Create a calendar event with optional attendees. Defaults to the caller's account. Set user_name to create on another user's calendar (requires their OAuth access). Sends email invitations to all attendees.",
      inputSchema: z.object({
        summary: z.string().describe("Event title"),
        start: z
          .string()
          .describe("Start time (ISO 8601), e.g. '2026-02-20T10:00:00+01:00'"),
        end: z
          .string()
          .describe("End time (ISO 8601), e.g. '2026-02-20T11:00:00+01:00'"),
        description: z.string().optional().describe("Event description"),
        location: z.string().optional().describe("Event location or meeting link"),
        attendees: z
          .array(z.string())
          .optional()
          .describe("List of attendee email addresses"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access another user's calendar instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ summary, start, end, description, location, attendees, user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const { createEvent } = await import("../lib/calendar.js");
          const event = await createEvent({
            summary,
            start,
            end,
            description: description || undefined,
            location: location || undefined,
            attendees: attendees || undefined,
          }, resolvedUserId);
          if (!event) {
            return {
              ok: false,
              error: user_name
                ? `No calendar access for '${user_name}'. They may need to authorize Aura via OAuth first.`
                : context?.userId
                  ? "You need to connect your Google account first. Ask me to generate an auth link."
                  : "Calendar is not configured. The OAuth token may need calendar scopes.",
            };
          }
          return { ok: true, event };
        } catch (error: any) {
          logger.error("create_event failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to create event: ${error.message}`,
          };
        }
      },
      slack: { status: "Creating event...", detail: (i) => i.summary },
    }),

    update_event: defineTool({
      description:
        "Update an existing calendar event. Only provided fields are changed. Defaults to the caller's account. Set user_name to update on another user's calendar (requires their OAuth access).",
      inputSchema: z.object({
        event_id: z.string().describe("The calendar event ID to update"),
        summary: z.string().optional().describe("New event title"),
        description: z.string().optional().describe("New event description"),
        start: z
          .string()
          .optional()
          .describe("New start time (ISO 8601)"),
        end: z
          .string()
          .optional()
          .describe("New end time (ISO 8601)"),
        location: z.string().optional().describe("New event location or meeting link"),
        attendees: z
          .array(z.string())
          .optional()
          .describe("New list of attendee email addresses (replaces existing)"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access another user's calendar instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ event_id, summary, description, start, end, location, attendees, user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const { updateEvent } = await import("../lib/calendar.js");
          const event = await updateEvent(event_id, {
            summary: summary || undefined,
            description: description || undefined,
            start: start || undefined,
            end: end || undefined,
            location: location || undefined,
            attendees: attendees || undefined,
          }, resolvedUserId);
          if (!event) {
            return {
              ok: false,
              error: user_name
                ? `No calendar access for '${user_name}'. They may need to authorize Aura via OAuth first.`
                : context?.userId
                  ? "You need to connect your Google account first. Ask me to generate an auth link."
                  : "Calendar is not configured. The OAuth token may need calendar scopes.",
            };
          }
          return { ok: true, event };
        } catch (error: any) {
          logger.error("update_event failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to update event: ${error.message}`,
          };
        }
      },
      slack: { status: "Updating event...", detail: (i) => i.event_id },
    }),

    delete_event: defineTool({
      description: "Delete a calendar event by its event ID. Defaults to the caller's account. Set user_name to delete from another user's calendar (requires their OAuth access).",
      inputSchema: z.object({
        event_id: z.string().describe("The calendar event ID to delete"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access another user's calendar instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ event_id, user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const { deleteEvent } = await import("../lib/calendar.js");
          const success = await deleteEvent(event_id, resolvedUserId);
          if (!success) {
            return {
              ok: false,
              error: user_name
                ? `No calendar access for '${user_name}'. They may need to authorize Aura via OAuth first.`
                : context?.userId
                  ? "You need to connect your Google account first. Ask me to generate an auth link."
                  : "Calendar is not configured. The OAuth token may need calendar scopes.",
            };
          }
          return { ok: true, message: `Event ${event_id} deleted successfully.` };
        } catch (error: any) {
          logger.error("delete_event failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to delete event: ${error.message}`,
          };
        }
      },
      slack: { status: "Deleting event..." },
    }),

    find_available_slot: defineTool({
      description:
        "Find available meeting slots across multiple people's calendars. Uses the free/busy API to find gaps where everyone is free. Defaults to the caller's account. Set user_name to query via another user's OAuth token (requires their OAuth access).",
      inputSchema: z.object({
        emails: z
          .array(z.string())
          .describe("Email addresses of people to check availability for"),
        time_min: z
          .string()
          .describe("Start of search range (ISO 8601)"),
        time_max: z
          .string()
          .describe("End of search range (ISO 8601)"),
        duration_minutes: z
          .number()
          .describe("Required meeting duration in minutes, e.g. 30"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access via another user's calendar API instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ emails, time_min, time_max, duration_minutes, user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const { findAvailableSlots } = await import("../lib/calendar.js");
          const slots = await findAvailableSlots({
            emails,
            timeMin: time_min,
            timeMax: time_max,
            durationMinutes: duration_minutes,
          }, resolvedUserId);
          if (!slots) {
            return {
              ok: false,
              error: user_name
                ? `No calendar access for '${user_name}'. They may need to authorize Aura via OAuth first.`
                : context?.userId
                  ? "You need to connect your Google account first. Ask me to generate an auth link."
                  : "Calendar is not configured. The OAuth token may need calendar scopes.",
            };
          }
          return {
            ok: true,
            count: slots.length,
            slots: slots.slice(0, 10),
          };
        } catch (error: any) {
          logger.error("find_available_slot failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to find slots: ${error.message}`,
          };
        }
      },
      slack: { status: "Finding availability..." },
    }),
  };
}

// ── Multi-user Gmail Tools ──────────────────────────────────────────────────

/**
 * Create tools for managing Gmail as an Executive Assistant.
 * These tools operate on behalf of specific users who have granted Aura OAuth access.
 * Caller identity enforcement: non-admin callers can only access their own email.
 */
export function createGmailEATools(context?: ScheduleContext) {
  const callerDefault = context?.userId || process.env.AURA_BOT_USER_ID || AURA_BOT_USER_ID;

  return {
    create_gmail_draft: defineTool({
      description:
        "Create a draft email in a user's Gmail account. Defaults to the caller's account. The user must have granted Aura OAuth access first. Supports optional file attachments (base64-encoded).",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "The display name, real name, or username of the Gmail account owner, e.g. 'Joan' or '@joan'. Defaults to the caller's account.",
          ),
        to: z.string().describe("Recipient email address"),
        subject: z.string().describe("Email subject line"),
        body: z.string().describe("Email body text"),
        cc: z.string().optional().describe("CC email address"),
        bcc: z.string().optional().describe("BCC email address"),
        in_reply_to: z
          .string()
          .optional()
          .describe("Message-ID to reply to (for threading)"),
        references: z
          .string()
          .optional()
          .describe("References header (for threading)"),
        thread_id: z
          .string()
          .optional()
          .describe("Gmail thread ID to add the draft to"),
        quoted_message: z
          .string()
          .optional()
          .describe("Original message text to quote in the reply"),
        attachments: z
          .array(
            z.object({
              filename: z.string().describe("Filename with extension, e.g. 'contract.pdf'"),
              mimeType: z.string().describe("MIME type, e.g. 'application/pdf'"),
              content: z.string().describe("Base64-encoded file content"),
            }),
          )
          .optional()
          .describe("File attachments (base64-encoded)"),
      }),
      execute: async ({
        user_name,
        to,
        subject,
        body,
        cc,
        bcc,
        in_reply_to,
        references,
        thread_id,
        quoted_message,
        attachments,
      }) => {
        try {
          let resolvedUserId: string;
          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
              };
            }
            resolvedUserId = userId;
          } else {
            resolvedUserId = callerDefault;
          }

          const callerId = context?.userId;
          if (callerId && callerId !== resolvedUserId && !isAdmin(callerId)) {
            return { ok: false, error: "You can only access your own email. Ask an admin for help." };
          }

          const { createDraft } = await import("../lib/gmail.js");
          const result = await createDraft(resolvedUserId, {
            to,
            subject,
            body,
            cc,
            bcc,
            inReplyTo: in_reply_to,
            references,
            threadId: thread_id,
            quotedMessage: quoted_message,
            attachments,
          });

          if (!result) {
            return {
              ok: false,
              error: `No Gmail access for the resolved user. They need to authorize Aura via the OAuth flow first.`,
            };
          }

          return {
            ok: true,
            draft_id: result.draftId,
            message_id: result.messageId,
            message: `Draft created: "${subject}" to ${to}`,
          };
        } catch (error: any) {
          logger.error("create_gmail_draft failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to create draft: ${error.message}`,
          };
        }
      },
      slack: { status: "Creating draft...", detail: (i) => i.to },
    }),

    list_gmail_drafts: defineTool({
      description:
        "List draft emails in a user's Gmail account. Defaults to the caller's account. The user must have granted Aura OAuth access.",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "The display name, real name, or username of the Gmail account owner. Defaults to the caller's account.",
          ),
        max_results: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Maximum number of drafts to return (default 10)"),
      }),
      execute: async ({ user_name, max_results }) => {
        try {
          let resolvedUserId: string;
          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'.`,
              };
            }
            resolvedUserId = userId;
          } else {
            resolvedUserId = callerDefault;
          }

          const callerId = context?.userId;
          if (callerId && callerId !== resolvedUserId && !isAdmin(callerId)) {
            return { ok: false, error: "You can only access your own email. Ask an admin for help." };
          }

          const { listDrafts } = await import("../lib/gmail.js");
          const drafts = await listDrafts(resolvedUserId, max_results);

          if (!drafts) {
            return {
              ok: false,
              error: `No Gmail access for the resolved user. They need to authorize Aura via OAuth first.`,
            };
          }

          return {
            ok: true,
            count: drafts.length,
            drafts,
          };
        } catch (error: any) {
          logger.error("list_gmail_drafts failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to list drafts: ${error.message}`,
          };
        }
      },
      slack: { status: "Listing drafts...", detail: (i) => i.user_name },
    }),

    read_user_emails: defineTool({
      description:
        "Read recent emails from a user's Gmail inbox. Defaults to the caller's account. The user must have granted Aura OAuth access. Supports pagination via page_token.",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "The display name, real name, or username of the Gmail account owner. Defaults to the caller's account.",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Gmail search query, e.g. 'from:someone@example.com' or 'is:unread'",
          ),
        max_results: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Maximum emails to return (default 10)"),
        unread_only: z
          .boolean()
          .optional()
          .default(false)
          .describe("Only show unread emails"),
        page_token: z
          .string()
          .optional()
          .describe("Page token from a previous response to fetch the next page of results"),
      }),
      execute: async ({ user_name, query, max_results, unread_only, page_token }) => {
        try {
          let resolvedUserId: string;
          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'.`,
              };
            }
            resolvedUserId = userId;
          } else {
            resolvedUserId = callerDefault;
          }

          const callerId = context?.userId;
          if (callerId && callerId !== resolvedUserId && !isAdmin(callerId)) {
            return { ok: false, error: "You can only access your own email. Ask an admin for help." };
          }

          const { readUserEmails } = await import("../lib/gmail.js");
          const result = await readUserEmails(resolvedUserId, {
            query,
            maxResults: max_results,
            unreadOnly: unread_only,
            pageToken: page_token,
          });

          if (!result) {
            return {
              ok: false,
              error: `No Gmail access for the resolved user. They need to authorize Aura via OAuth first.`,
            };
          }

          return {
            ok: true,
            count: result.emails.length,
            emails: result.emails,
            next_page_token: result.nextPageToken || undefined,
          };
        } catch (error: any) {
          logger.error("read_user_emails failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to read emails: ${error.message}`,
          };
        }
      },
      slack: { status: "Reading emails...", detail: (i) => i.user_name },
    }),

    read_user_email: defineTool({
      description:
        "Read the full content of a specific email from a user's Gmail account by message ID. Defaults to the caller's account.",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "The display name, real name, or username of the Gmail account owner. Defaults to the caller's account.",
          ),
        message_id: z
          .string()
          .describe("The Gmail message ID to read"),
      }),
      execute: async ({ user_name, message_id }) => {
        try {
          let resolvedUserId: string;
          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'.`,
              };
            }
            resolvedUserId = userId;
          } else {
            resolvedUserId = callerDefault;
          }

          const callerId = context?.userId;
          if (callerId && callerId !== resolvedUserId && !isAdmin(callerId)) {
            return { ok: false, error: "You can only access your own email. Ask an admin for help." };
          }

          const { readUserEmail } = await import("../lib/gmail.js");
          const email = await readUserEmail(resolvedUserId, message_id);

          if (!email) {
            return {
              ok: false,
              error: `No Gmail access for the resolved user, or message not found.`,
            };
          }

          return {
            ok: true,
            ...email,
          };
        } catch (error: any) {
          logger.error("read_user_email failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to read email: ${error.message}`,
          };
        }
      },
      slack: { status: "Reading email...", detail: (i) => i.user_name },
    }),

    delete_gmail_draft: defineTool({
      description:
        "Delete a draft email from a user's Gmail account. Defaults to the caller's account. The user must have granted Aura OAuth access.",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "The display name, real name, or username of the Gmail account owner. Defaults to the caller's account.",
          ),
        draft_id: z
          .string()
          .describe("The Gmail draft ID to delete"),
      }),
      execute: async ({ user_name, draft_id }) => {
        try {
          let resolvedUserId: string;
          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'.`,
              };
            }
            resolvedUserId = userId;
          } else {
            resolvedUserId = callerDefault;
          }

          const callerId = context?.userId;
          if (callerId && callerId !== resolvedUserId && !isAdmin(callerId)) {
            return { ok: false, error: "You can only access your own email. Ask an admin for help." };
          }

          const { deleteDraft } = await import("../lib/gmail.js");
          const success = await deleteDraft(resolvedUserId, draft_id);

          if (!success) {
            return {
              ok: false,
              error: `No Gmail access for the resolved user, or draft not found.`,
            };
          }

          return {
            ok: true,
            message: `Draft ${draft_id} deleted.`,
          };
        } catch (error: any) {
          logger.error("delete_gmail_draft failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to delete draft: ${error.message}`,
          };
        }
      },
      slack: { status: "Deleting draft..." },
    }),

    download_email_attachment: defineTool({
      description:
        "Download an attachment from a Gmail message. Defaults to the caller's account. Returns base64-encoded file content by default. When save_to_disk is true, the file is written to /home/user/downloads/{filename} on the sandbox filesystem and the path is returned instead of base64. Use save_to_disk when you need to process the file with shell tools like pdftotext, or pass it to other commands. Use read_user_email first to get the message_id and attachment_id. The returned base64 can be passed directly to create_gmail_draft attachments.",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "The display name, real name, or username of the Gmail account owner. Defaults to the caller's account.",
          ),
        message_id: z
          .string()
          .describe("The Gmail message ID containing the attachment"),
        attachment_id: z
          .string()
          .describe("The attachment ID from read_user_email results"),
        filename: z
          .string()
          .optional()
          .describe("Original filename (for display purposes)"),
        mime_type: z
          .string()
          .optional()
          .describe("MIME type of the attachment (for display purposes)"),
        save_to_disk: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, writes the file to /home/user/downloads/{filename} on the sandbox instead of returning base64. Use when you need to process the file with shell tools.",
          ),
      }),
      execute: async ({ user_name, message_id, attachment_id, filename, mime_type, save_to_disk }) => {
        try {
          let resolvedUserId: string;
          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
              };
            }
            resolvedUserId = userId;
          } else {
            resolvedUserId = callerDefault;
          }

          const callerId = context?.userId;
          if (callerId && callerId !== resolvedUserId && !isAdmin(callerId)) {
            return { ok: false, error: "You can only access your own email. Ask an admin for help." };
          }

          const { getUserEmailAttachment, readUserEmail } = await import(
            "../lib/gmail.js"
          );

          let resolvedFilename = filename;
          let resolvedMimeType = mime_type;

          if (!resolvedFilename || !resolvedMimeType) {
            const email = await readUserEmail(resolvedUserId, message_id);
            if (email) {
              const att = email.attachments.find(
                (a: any) => a.attachmentId === attachment_id,
              );
              if (att) {
                resolvedFilename = resolvedFilename || att.filename;
                resolvedMimeType = resolvedMimeType || att.mimeType;
              }
            }
          }

          const result = await getUserEmailAttachment(
            resolvedUserId,
            message_id,
            attachment_id,
          );

          if (!result) {
            return {
              ok: false,
              error: `No Gmail access for the resolved user, or attachment not found.`,
            };
          }

          const resolvedName = resolvedFilename || "attachment";

          logger.info("download_email_attachment called", {
            userId: resolvedUserId,
            messageId: message_id,
            attachmentId: attachment_id,
            filename: resolvedName,
            size: result.size,
            save_to_disk,
          });

          if (save_to_disk) {
            const { writeToSandbox } = await import("../lib/sandbox.js");
            const buf = Buffer.from(result.data, "base64");
            const savedPath = await writeToSandbox(resolvedName, buf);
            return {
              ok: true,
              saved_to_disk: true,
              path: savedPath,
              filename: resolvedName,
              mimeType: resolvedMimeType || "application/octet-stream",
              size: result.size,
            };
          }

          return {
            ok: true,
            filename: resolvedName,
            mimeType: resolvedMimeType || "application/octet-stream",
            size: result.size,
            content_base64: result.data,
          };
        } catch (error: any) {
          logger.error("download_email_attachment failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to download attachment: ${error.message}`,
          };
        }
      },
      slack: { status: "Downloading attachment...", detail: (i) => i.filename ?? i.attachment_id },
    }),

    generate_gmail_auth_url: defineTool({
      description:
        "Generate a Google OAuth consent URL for a user to connect their Gmail account to Aura. DM the resulting URL to the user — they click it, authorize in Google, and their Gmail is connected for reading and drafting.",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "The display name, real name, or username of the Gmail account owner, e.g. 'Joan' or '@joan'. Defaults to the caller.",
          ),
      }),
      execute: async ({ user_name }) => {
        try {
          let resolvedUserId: string;
          if (user_name) {
            const userId = await resolveSlackUserId(user_name);
            if (!userId) {
              return {
                ok: false,
                error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
              };
            }
            resolvedUserId = userId;
          } else {
            resolvedUserId = callerDefault;
          }

          const callerId = context?.userId;
          if (callerId && callerId !== resolvedUserId && !isAdmin(callerId)) {
            return { ok: false, error: "You can only generate an auth URL for your own account. Ask an admin for help." };
          }

          const { generateAuthUrlForUser } = await import("../lib/gmail.js");
          const url = generateAuthUrlForUser(resolvedUserId);
          if (!url) {
            return {
              ok: false,
              error: "Google OAuth credentials not configured. Cannot generate auth URL.",
            };
          }

          return {
            ok: true,
            url,
            user_id: resolvedUserId,
            message: `OAuth consent URL generated. DM this link to the user — they click it, authorize in Google, and their Gmail is connected.`,
          };
        } catch (err: any) {
          logger.error("generate_gmail_auth_url failed", { error: err?.message || String(err) });
          return { ok: false, error: err?.message || String(err) };
        }
      },
      slack: { status: "Generating auth URL..." },
    }),
  };
}

