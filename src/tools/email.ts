import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";

// ── Tool Definitions ────────────────────────────────────────────────────────

/**
 * Create email tools for the AI SDK.
 * Uses dynamic import for gmail.js to avoid loading googleapis on every request.
 */
export function createEmailTools() {
  return {
    send_email: defineTool({
      description:
        "Send an email from aura@realadvisor.com. Use for external communication, follow-ups, outreach, and reports. Never send emails without being asked or having a clear reason (job, follow-up, etc.). Body is sent as plain text — keep it professional but conversational, same tone as Slack. DM privacy applies: don't email someone's private Slack DM content to others. Supports optional file attachments (base64-encoded).",
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
        attachments,
      }) => {
        try {
          const { getGmailClient, sendEmail } = await import(
            "../lib/gmail.js"
          );
          const client = await getGmailClient();
          if (!client) {
            return {
              ok: false,
              error:
                "Gmail is not configured. Set GOOGLE_EMAIL_CLIENT_ID, GOOGLE_EMAIL_CLIENT_SECRET, and GOOGLE_EMAIL_REFRESH_TOKEN.",
            };
          }

          const result = await sendEmail(to, subject, body, {
            cc,
            bcc,
            replyToMessageId: reply_to_message_id,
            threadId: thread_id,
            attachments,
          });

          if (!result) {
            return { ok: false, error: "Failed to send email: no response from Gmail API" };
          }

          logger.info("send_email tool called", {
            to,
            subject,
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

    read_emails: defineTool({
      description:
        "Read recent emails from Aura's inbox. Can filter by unread status or search query. Supports pagination: pass page_token from a previous response's next_page_token to fetch the next page.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Gmail search query, e.g. 'from:someone@example.com' or 'is:unread'",
          ),
        max_results: z
          .number()
          .optional()
          .default(10)
          .describe("Maximum emails to return (max 20)"),
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
      execute: async ({ query, max_results, unread_only, page_token }) => {
        try {
          const { getGmailClient, listEmails } = await import(
            "../lib/gmail.js"
          );
          const client = await getGmailClient();
          if (!client) {
            return {
              ok: false,
              error:
                "Gmail is not configured. Set GOOGLE_EMAIL_CLIENT_ID, GOOGLE_EMAIL_CLIENT_SECRET, and GOOGLE_EMAIL_REFRESH_TOKEN.",
            };
          }

          const result = await listEmails({
            query,
            maxResults: max_results,
            unreadOnly: unread_only,
            pageToken: page_token,
          });

          if (!result) {
            return { ok: false, error: "Failed to list emails: no response from Gmail API" };
          }

          logger.info("read_emails tool called", {
            query,
            count: result.emails.length,
          });

          return {
            ok: true,
            emails: result.emails,
            count: result.emails.length,
            next_page_token: result.nextPageToken || undefined,
          };
        } catch (error: any) {
          logger.error("read_emails tool failed", {
            query,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read emails: ${error.message}`,
          };
        }
      },
      slack: { status: "Reading emails...", output: (r) => r.ok === false ? r.error : `${r.emails?.length ?? r.count ?? 0} emails` },
    }),

    read_email: defineTool({
      description:
        "Read the full content of a specific email by its message ID.",
      inputSchema: z.object({
        message_id: z.string().describe("The Gmail message ID to read"),
      }),
      execute: async ({ message_id }) => {
        try {
          const { getGmailClient, getEmail } = await import(
            "../lib/gmail.js"
          );
          const client = await getGmailClient();
          if (!client) {
            return {
              ok: false,
              error:
                "Gmail is not configured. Set GOOGLE_EMAIL_CLIENT_ID, GOOGLE_EMAIL_CLIENT_SECRET, and GOOGLE_EMAIL_REFRESH_TOKEN.",
            };
          }

          const email = await getEmail(message_id);

          if (!email) {
            return { ok: false, error: `Email not found: ${message_id}` };
          }

          logger.info("read_email tool called", {
            messageId: message_id,
            subject: email.subject,
          });

          return {
            ok: true,
            email,
          };
        } catch (error: any) {
          logger.error("read_email tool failed", {
            messageId: message_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read email: ${error.message}`,
          };
        }
      },
      slack: { status: "Reading email...", detail: (i) => i.message_id },
    }),

    reply_to_email: defineTool({
      description: "Reply to an existing email thread. Requires message_id and thread_id from read_emails or read_email.",
      inputSchema: z.object({
        message_id: z
          .string()
          .describe("Message ID of the email to reply to"),
        thread_id: z
          .string()
          .describe("Thread ID for proper threading"),
        body: z.string().describe("Reply body text"),
      }),
      execute: async ({ message_id, thread_id, body }) => {
        try {
          const { getGmailClient, replyToEmail } = await import(
            "../lib/gmail.js"
          );
          const client = await getGmailClient();
          if (!client) {
            return {
              ok: false,
              error:
                "Gmail is not configured. Set GOOGLE_EMAIL_CLIENT_ID, GOOGLE_EMAIL_CLIENT_SECRET, and GOOGLE_EMAIL_REFRESH_TOKEN.",
            };
          }

          const result = await replyToEmail(message_id, thread_id, body);

          if (!result) {
            return { ok: false, error: "Failed to reply to email: no response from Gmail API" };
          }

          logger.info("reply_to_email tool called", {
            originalMessageId: message_id,
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
        "List upcoming calendar events for aura@realadvisor.com. Use to check schedule, find meetings, or see what's coming up.",
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
      }),
      execute: async ({ time_min, time_max, max_results, query }) => {
        try {
          const { listEvents } = await import("../lib/calendar.js");
          const events = await listEvents({
            timeMin: time_min,
            timeMax: time_max,
            maxResults: max_results,
            query: query || undefined,
          });
          if (!events) {
            return {
              ok: false,
              error:
                "Calendar is not configured. The OAuth token may need calendar scopes.",
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
        "Create a calendar event with optional attendees. Sends email invitations to all attendees.",
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
      }),
      execute: async ({ summary, start, end, description, location, attendees }) => {
        try {
          const { createEvent } = await import("../lib/calendar.js");
          const event = await createEvent({
            summary,
            start,
            end,
            description: description || undefined,
            location: location || undefined,
            attendees: attendees || undefined,
          });
          if (!event) {
            return {
              ok: false,
              error:
                "Calendar is not configured. The OAuth token may need calendar scopes.",
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
        "Update an existing calendar event. Only provided fields are changed.",
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
      }),
      execute: async ({ event_id, summary, description, start, end, location, attendees }) => {
        try {
          const { updateEvent } = await import("../lib/calendar.js");
          const event = await updateEvent(event_id, {
            summary: summary || undefined,
            description: description || undefined,
            start: start || undefined,
            end: end || undefined,
            location: location || undefined,
            attendees: attendees || undefined,
          });
          if (!event) {
            return {
              ok: false,
              error:
                "Calendar is not configured. The OAuth token may need calendar scopes.",
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
      description: "Delete a calendar event by its event ID.",
      inputSchema: z.object({
        event_id: z.string().describe("The calendar event ID to delete"),
      }),
      execute: async ({ event_id }) => {
        try {
          const { deleteEvent } = await import("../lib/calendar.js");
          const success = await deleteEvent(event_id);
          if (!success) {
            return {
              ok: false,
              error:
                "Calendar is not configured. The OAuth token may need calendar scopes.",
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
        "Find available meeting slots across multiple people's calendars. Uses the free/busy API to find gaps where everyone is free.",
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
      }),
      execute: async ({ emails, time_min, time_max, duration_minutes }) => {
        try {
          const { findAvailableSlots } = await import("../lib/calendar.js");
          const slots = await findAvailableSlots({
            emails,
            timeMin: time_min,
            timeMax: time_max,
            durationMinutes: duration_minutes,
          });
          if (!slots) {
            return {
              ok: false,
              error:
                "Calendar is not configured. The OAuth token may need calendar scopes.",
            };
          }
          return {
            ok: true,
            count: slots.length,
            slots: slots.slice(0, 10), // cap at 10 suggestions
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
 */
export function createGmailEATools() {
  return {
    create_gmail_draft: defineTool({
      description:
        "Create a draft email in a user's Gmail account. The user must have granted Aura OAuth access first. Supports optional file attachments (base64-encoded).",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner, e.g. 'Joan' or '@joan'",
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
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
            };
          }

          const { createDraft } = await import("../lib/gmail.js");
          const result = await createDraft(userId, {
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
              error: `No Gmail access for user '${user_name}'. They need to authorize Aura via the OAuth flow first.`,
            };
          }

          return {
            ok: true,
            draft_id: result.draftId,
            message_id: result.messageId,
            message: `Draft created in ${user_name}'s Gmail: "${subject}" to ${to}`,
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
        "List draft emails in a user's Gmail account. The user must have granted Aura OAuth access.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
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
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'.`,
            };
          }

          const { listDrafts } = await import("../lib/gmail.js");
          const drafts = await listDrafts(userId, max_results);

          if (!drafts) {
            return {
              ok: false,
              error: `No Gmail access for user '${user_name}'. They need to authorize Aura via OAuth first.`,
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
        "Read recent emails from a specific user's Gmail inbox. The user must have granted Aura OAuth access. Supports pagination via page_token.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
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
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'.`,
            };
          }

          const { readUserEmails } = await import("../lib/gmail.js");
          const result = await readUserEmails(userId, {
            query,
            maxResults: max_results,
            unreadOnly: unread_only,
            pageToken: page_token,
          });

          if (!result) {
            return {
              ok: false,
              error: `No Gmail access for user '${user_name}'. They need to authorize Aura via OAuth first.`,
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
        "Read the full content of a specific email from a user's Gmail account by message ID.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
          ),
        message_id: z
          .string()
          .describe("The Gmail message ID to read"),
      }),
      execute: async ({ user_name, message_id }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'.`,
            };
          }

          const { readUserEmail } = await import("../lib/gmail.js");
          const email = await readUserEmail(userId, message_id);

          if (!email) {
            return {
              ok: false,
              error: `No Gmail access for user '${user_name}', or message not found.`,
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
        "Delete a draft email from a user's Gmail account. The user must have granted Aura OAuth access.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
          ),
        draft_id: z
          .string()
          .describe("The Gmail draft ID to delete"),
      }),
      execute: async ({ user_name, draft_id }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'.`,
            };
          }

          const { deleteDraft } = await import("../lib/gmail.js");
          const success = await deleteDraft(userId, draft_id);

          if (!success) {
            return {
              ok: false,
              error: `No Gmail access for user '${user_name}', or draft not found.`,
            };
          }

          return {
            ok: true,
            message: `Draft ${draft_id} deleted from ${user_name}'s Gmail.`,
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
        "Download an attachment from a Gmail message. Returns base64-encoded file content. Use read_user_email first to get the message_id and attachment_id. The returned base64 can be passed directly to create_gmail_draft attachments or saved to the sandbox.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
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
      }),
      execute: async ({ user_name, message_id, attachment_id, filename, mime_type }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
            };
          }

          const { getUserEmailAttachment, readUserEmail } = await import(
            "../lib/gmail.js"
          );

          let resolvedFilename = filename;
          let resolvedMimeType = mime_type;

          if (!resolvedFilename || !resolvedMimeType) {
            const email = await readUserEmail(userId, message_id);
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
            userId,
            message_id,
            attachment_id,
          );

          if (!result) {
            return {
              ok: false,
              error: `No Gmail access for user '${user_name}', or attachment not found.`,
            };
          }

          logger.info("download_email_attachment called", {
            userId,
            messageId: message_id,
            attachmentId: attachment_id,
            filename: resolvedFilename,
            size: result.size,
          });

          return {
            ok: true,
            filename: resolvedFilename || "attachment",
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
          .describe(
            "The display name, real name, or username of the Gmail account owner, e.g. 'Joan' or '@joan'",
          ),
      }),
      execute: async ({ user_name }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
            };
          }

          const { generateAuthUrlForUser } = await import("../lib/gmail.js");
          const url = generateAuthUrlForUser(userId);
          if (!url) {
            return {
              ok: false,
              error: "Google OAuth credentials not configured. Cannot generate auth URL.",
            };
          }

          return {
            ok: true,
            url,
            user_id: userId,
            message: `OAuth consent URL generated for ${user_name}. DM this link to them — they click it, authorize in Google, and their Gmail is connected.`,
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

/**
 * Resolve a user display name / username to a Slack user ID.
 * Reuses the paginated, cached getUserList from slack.ts.
 */
async function resolveSlackUserId(
  userName: string,
): Promise<string | null> {
  try {
    const { WebClient } = await import("@slack/web-api");
    const { getUserList } = await import("./slack.js");
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const users = await getUserList(client);

    const normalizedInput = userName
      .replace(/^@/, "")
      .toLowerCase()
      .trim();

    // Exact match
    for (const user of users) {
      if (
        user.displayName.toLowerCase() === normalizedInput ||
        user.realName.toLowerCase() === normalizedInput ||
        user.username.toLowerCase() === normalizedInput
      ) {
        return user.id;
      }
    }

    // Fuzzy match (starts with)
    for (const user of users) {
      if (
        user.displayName.toLowerCase().startsWith(normalizedInput) ||
        user.realName.toLowerCase().startsWith(normalizedInput) ||
        user.username.toLowerCase().startsWith(normalizedInput)
      ) {
        return user.id;
      }
    }

    return null;
  } catch (error: any) {
    logger.error("Failed to resolve Slack user ID", {
      userName,
      error: error.message,
    });
    return null;
  }
}
