import { tool } from "ai";
import { z } from "zod";
import { logger } from "../lib/logger.js";

// ── Tool Definitions ────────────────────────────────────────────────────────

/**
 * Create email tools for the AI SDK.
 * Uses dynamic import for gmail.js to avoid loading googleapis on every request.
 */
export function createEmailTools() {
  return {
    send_email: tool({
      description:
        "Send an email from aura@realadvisor.com. Use for external communication, follow-ups, outreach, and reports. Supports optional file attachments (base64-encoded).",
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
    }),

    read_emails: tool({
      description:
        "Read recent emails from Aura's inbox. Can filter by unread status or search query. Supports pagination via page_token.",
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
    }),

    read_email: tool({
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
    }),

    reply_to_email: tool({
      description: "Reply to an existing email thread.",
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
    }),

    // ── Workspace Directory Tools ───────────────────────────────────────────

    lookup_workspace_user: tool({
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
    }),

    list_workspace_users: tool({
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
    }),

    // ── Contact Lookup ──────────────────────────────────────────────────────

    lookup_contact: tool({
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
    }),

    // ── Calendar Tools ──────────────────────────────────────────────────────

    check_calendar: tool({
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
    }),

    create_event: tool({
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
    }),

    update_event: tool({
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
    }),

    delete_event: tool({
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
    }),

    find_available_slot: tool({
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
    create_gmail_draft: tool({
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
    }),

    list_gmail_drafts: tool({
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
    }),

    read_user_emails: tool({
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
    }),

    read_user_email: tool({
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
    }),

    delete_gmail_draft: tool({
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
    }),

    sync_gmail: tool({
      description:
        "Sync emails from a user's Gmail account into the local emails_raw staging table. Fetches emails since a given date, converts HTML to markdown, and runs a Haiku triage pass to flag important/actionable emails for a startup CEO. Returns counts of synced, important, and skipped emails.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
          ),
        since: z
          .string()
          .optional()
          .default("2025-01-01")
          .describe("ISO date to sync emails from (default '2025-01-01')"),
        max_emails: z
          .number()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe("Maximum number of emails to sync (default 100, max 500)"),
      }),
      execute: async ({ user_name, since, max_emails }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
            };
          }

          const { getGmailClientForUser } = await import("../lib/gmail.js");
          const gmailResult = await getGmailClientForUser(userId);
          if (!gmailResult) {
            return {
              ok: false,
              error: `No Gmail access for user '${user_name}'. They need to authorize Aura via OAuth first.`,
            };
          }
          const gmail = gmailResult.client;

          // Convert since date to Unix epoch for Gmail query
          const sinceDate = new Date(since ?? "2025-01-01");
          const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);

          // Fetch message IDs
          const listRes = await gmail.users.messages.list({
            userId: "me",
            q: `after:${sinceEpoch}`,
            maxResults: max_emails ?? 100,
          });

          const messages = listRes.data.messages ?? [];
          if (messages.length === 0) {
            return { ok: true, synced: 0, important: 0, skipped: 0 };
          }

          // Import dependencies
          const { db } = await import("../db/client.js");
          const { emailsRaw } = await import("../db/schema.js");
          const { generateText } = await import("ai");
          const { getFastModel } = await import("../lib/ai.js");
          const TurndownService = (await import("turndown")).default;
          const td = new TurndownService();
          const { sql: drizzleSql } = await import("drizzle-orm");

          let synced = 0;
          let important = 0;
          let skipped = 0;

          // Process in batches of 10
          const BATCH_SIZE = 10;
          for (let i = 0; i < messages.length; i += BATCH_SIZE) {
            const batch = messages.slice(i, i + BATCH_SIZE);
            await Promise.all(
              batch.map(async (msg) => {
                try {
                  const msgId = msg.id!;
                  const fullMsg = await gmail.users.messages.get({
                    userId: "me",
                    id: msgId,
                    format: "full",
                  });
                  const payload = fullMsg.data.payload;
                  const headers = payload?.headers ?? [];

                  const getHeader = (name: string) =>
                    headers.find(
                      (h) => h.name?.toLowerCase() === name.toLowerCase(),
                    )?.value ?? null;

                  const subject = getHeader("Subject");
                  const fromAddress = getHeader("From");
                  const toRaw = getHeader("To");
                  const ccRaw = getHeader("Cc");
                  const dateRaw = getHeader("Date");

                  const toAddresses = toRaw
                    ? toRaw.split(",").map((s) => s.trim())
                    : [];
                  const ccAddresses = ccRaw
                    ? ccRaw.split(",").map((s) => s.trim())
                    : [];
                  const date = dateRaw ? new Date(dateRaw) : null;

                  const labels = fullMsg.data.labelIds ?? [];
                  const sizeBytes = fullMsg.data.sizeEstimate ?? null;
                  const threadId = fullMsg.data.threadId ?? "";

                  // Extract HTML body recursively from parts
                  const extractBody = (
                    part: any,
                  ): { html: string | null; plain: string | null } => {
                    if (!part) return { html: null, plain: null };
                    if (part.mimeType === "text/html" && part.body?.data) {
                      return {
                        html: Buffer.from(
                          part.body.data,
                          "base64",
                        ).toString("utf8"),
                        plain: null,
                      };
                    }
                    if (part.mimeType === "text/plain" && part.body?.data) {
                      return {
                        html: null,
                        plain: Buffer.from(
                          part.body.data,
                          "base64",
                        ).toString("utf8"),
                      };
                    }
                    if (part.parts) {
                      let html: string | null = null;
                      let plain: string | null = null;
                      for (const p of part.parts) {
                        const result = extractBody(p);
                        if (result.html) html = result.html;
                        if (result.plain) plain = result.plain;
                      }
                      return { html, plain };
                    }
                    return { html: null, plain: null };
                  };

                  const { html: bodyHtml, plain: bodyPlain } =
                    extractBody(payload);
                  const bodyMarkdown = bodyHtml
                    ? td.turndown(bodyHtml)
                    : (bodyPlain ?? null);

                  // Haiku triage gate
                  let isImportant: boolean | null = null;
                  let triageReason: string | null = null;
                  try {
                    const model = await getFastModel();
                    const preview = (bodyMarkdown ?? "").slice(0, 500);
                    const { text: triageRaw } = await generateText({
                      model,
                      system:
                        "You are an email triage assistant for a startup CEO. Classify emails as important/actionable or not. Reply with valid JSON only.",
                      prompt: `Subject: ${subject ?? "(no subject)"}\nFrom: ${fromAddress ?? "(unknown)"}\n\nBody preview:\n${preview}\n\nReply with JSON: {"is_important": true/false, "reason": "brief explanation"}`,
                      maxOutputTokens: 100,
                    });
                    const parsed = JSON.parse(
                      triageRaw.trim().replace(/^```json\n?/, "").replace(/\n?```$/, ""),
                    );
                    isImportant = Boolean(parsed.is_important);
                    triageReason = String(parsed.reason ?? "");
                  } catch {
                    // Triage failure is non-fatal; leave null
                  }

                  // Upsert into emails_raw
                  await db
                    .insert(emailsRaw)
                    .values({
                      userId,
                      gmailMessageId: msgId,
                      threadId,
                      subject,
                      fromAddress,
                      toAddresses,
                      ccAddresses,
                      date: date ?? undefined,
                      bodyMarkdown,
                      bodyHtml,
                      labels,
                      sizeBytes,
                      isImportant,
                      triageReason,
                    })
                    .onConflictDoUpdate({
                      target: [emailsRaw.userId, emailsRaw.gmailMessageId],
                      set: {
                        subject: drizzleSql`EXCLUDED.subject`,
                        fromAddress: drizzleSql`EXCLUDED.from_address`,
                        toAddresses: drizzleSql`EXCLUDED.to_addresses`,
                        ccAddresses: drizzleSql`EXCLUDED.cc_addresses`,
                        date: drizzleSql`EXCLUDED.date`,
                        bodyMarkdown: drizzleSql`EXCLUDED.body_markdown`,
                        bodyHtml: drizzleSql`EXCLUDED.body_html`,
                        labels: drizzleSql`EXCLUDED.labels`,
                        sizeBytes: drizzleSql`EXCLUDED.size_bytes`,
                        isImportant: drizzleSql`EXCLUDED.is_important`,
                        triageReason: drizzleSql`EXCLUDED.triage_reason`,
                        syncedAt: drizzleSql`now()`,
                      },
                    });

                  synced++;
                  if (isImportant) important++;
                } catch (emailErr: any) {
                  logger.warn("sync_gmail: failed to process email", {
                    msgId: msg.id,
                    error: emailErr.message,
                  });
                  skipped++;
                }
              }),
            );
          }

          logger.info("sync_gmail tool called", {
            userId,
            synced,
            important,
            skipped,
          });

          return { ok: true, synced, important, skipped };
        } catch (error: any) {
          logger.error("sync_gmail failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to sync Gmail: ${error.message}`,
          };
        }
      },
    }),

    generate_gmail_auth_url: tool({
      description:
        "Generate a Google OAuth consent URL for a user to connect their Gmail account. DM the resulting URL to the user so they can click it and authorize Aura to read their inbox and create drafts.",
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
