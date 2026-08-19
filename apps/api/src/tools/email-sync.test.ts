import { beforeEach, describe, expect, it, vi } from "vitest";

const userRows = new Map<string, Array<{ id: string; displayName: string; realName: string; username: string }>>();
const selectQueues = new Map<string, unknown[][]>();
const updateReturningQueue: unknown[][] = [];
const syncEmailsMock = vi.fn();
const computeThreadStatesMock = vi.fn();
const hasRoleMock = vi.fn();

const slackClient = {
  users: {
    list: vi.fn(async () => ({
      members: [
        {
          id: "UJOAN",
          name: "joan",
          real_name: "Joan Rodriguez",
          profile: { display_name: "Joan" },
        },
      ],
    })),
  },
};

function queueSelect(key: string, rows: unknown[]) {
  const queue = selectQueues.get(key) ?? [];
  queue.push(rows);
  selectQueues.set(key, queue);
}

function takeSelectRows(key: string): unknown[] {
  const queue = selectQueues.get(key);
  if (!queue || queue.length === 0) return [];
  return queue.shift() ?? [];
}

function createSelectBuilder(kind: "select" | "selectDistinct") {
  const builder = {
    from(table: unknown) {
      const tableName = (table as any)?.[Symbol.for("drizzle:Name")];
      if (tableName === "users") {
        return {
          where() {
            return {
              limit() {
                return userRows.get("users") ?? [];
              },
            };
          },
        };
      }

      return {
        where() {
          return {
            orderBy() {
              return {
                limit() {
                  return takeSelectRows("emailRows");
                },
              };
            },
            groupBy() {
              return takeSelectRows("threadCounts");
            },
            then(resolve: (rows: unknown[]) => unknown) {
              const key = kind === "selectDistinct" ? "matchingThreads" : "latestDate";
              return Promise.resolve(resolve(takeSelectRows(key)));
            },
          };
        },
      };
    },
  };

  return builder;
}

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(() => createSelectBuilder("select")),
    selectDistinct: vi.fn(() => createSelectBuilder("selectDistinct")),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => updateReturningQueue.shift() ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => [{ id: "action-log-id" }]),
      })),
    })),
  },
}));

vi.mock("../lib/email-sync.js", () => ({
  syncEmails: syncEmailsMock,
}));

vi.mock("../lib/email-triage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/email-triage.js")>()),
  computeThreadStates: computeThreadStatesMock,
}));

vi.mock("../lib/permissions.js", () => ({
  hasRole: hasRoleMock,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("email sync tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userRows.clear();
    selectQueues.clear();
    updateReturningQueue.length = 0;
    userRows.set("users", [
      { id: "UJOAN", displayName: "Joan", realName: "Joan Rodriguez", username: "joan" },
    ]);
    syncEmailsMock.mockResolvedValue({
      synced: 0,
      skipped: 0,
      errors: 0,
      errorDetails: [],
    });
    computeThreadStatesMock.mockResolvedValue({ processed: 1, breakdown: {} });
    hasRoleMock.mockResolvedValue(false);
  });

  it("exposes sync_emails, email_digest, and update_email_thread to OAuth-owning job users", async () => {
    const { createEmailSyncTools } = await import("./email-sync.js");
    const { filterToolsByCredentials } = await import("../lib/tool.js");

    const tools = createEmailSyncTools(slackClient as any, { userId: "UJOAN" });
    const visibleTools = filterToolsByCredentials(tools, new Set(["google_oauth"]));

    expect(visibleTools).toHaveProperty("sync_emails");
    expect(visibleTools).toHaveProperty("email_digest");
    expect(visibleTools).toHaveProperty("update_email_thread");
  });

  it("does not expose email pipeline tools without Google OAuth", async () => {
    const { createEmailSyncTools } = await import("./email-sync.js");
    const { filterToolsByCredentials } = await import("../lib/tool.js");

    const tools = createEmailSyncTools(slackClient as any, { userId: "UJOAN" });
    const visibleTools = filterToolsByCredentials(tools, new Set());

    expect(visibleTools).not.toHaveProperty("sync_emails");
    expect(visibleTools).not.toHaveProperty("email_digest");
    expect(visibleTools).not.toHaveProperty("update_email_thread");
  });

  it("refreshes stale email data before building a digest", async () => {
    const { createEmailSyncTools } = await import("./email-sync.js");
    const tools = createEmailSyncTools(slackClient as any, { userId: "UJOAN" });

    queueSelect("latestDate", [{ latestDate: new Date("2026-03-26T05:28:46.000Z") }]);
    queueSelect("emailRows", []);
    queueSelect("threadCounts", []);

    const result = await (tools.email_digest as any).execute({
      user_name: "Joan",
      include_fyi: false,
    });

    expect(syncEmailsMock).toHaveBeenCalledWith("UJOAN", {
      query: "newer_than:30d",
      maxMessages: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.sync).toMatchObject({
      attempted: true,
      reason: "email_digest_stale_check",
    });
  });

  it("syncs recent Gmail and retries when update_email_thread initially misses", async () => {
    const { createEmailSyncTools } = await import("./email-sync.js");
    const tools = createEmailSyncTools(slackClient as any, { userId: "UJOAN" });

    queueSelect("matchingThreads", []);
    queueSelect("matchingThreads", [{ gmailThreadId: "thread-123", subject: "Current thread" }]);
    updateReturningQueue.push([{ gmailThreadId: "thread-123" }]);

    const result = await (tools.update_email_thread as any).execute({
      user_name: "Joan",
      gmail_thread_id: "thread-123",
      thread_state: "resolved",
      reason: "handled",
    });

    expect(syncEmailsMock).toHaveBeenCalledWith("UJOAN", {
      query: "newer_than:30d",
      maxMessages: 200,
    });
    expect(result).toMatchObject({
      ok: true,
      updated: 1,
      sync: {
        attempted: true,
        reason: "update_email_thread_not_found",
      },
    });
  });

  it("blocks cross-user email sync for non-admin callers", async () => {
    const { createEmailSyncTools } = await import("./email-sync.js");
    const tools = createEmailSyncTools(slackClient as any, { userId: "UOTHER" });

    const result = await (tools.sync_emails as any).execute({
      user_name: "Joan",
      newer_than: "7d",
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("own email pipeline");
    expect(syncEmailsMock).not.toHaveBeenCalled();
  });
});
