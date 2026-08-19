import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safePostMessageMock = vi.hoisted(() => vi.fn());
const resolveSlackDestinationMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: loggerMock,
}));

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: safePostMessageMock,
}));

vi.mock("../tools/slack.js", () => ({
  resolveSlackDestination: resolveSlackDestinationMock,
}));

const originalFounderUserId = process.env.FOUNDER_USER_ID;
const originalAuraOpsChannel = process.env.AURA_OPS_CHANNEL;

beforeEach(() => {
  delete process.env.FOUNDER_USER_ID;
  delete process.env.AURA_OPS_CHANNEL;
  vi.clearAllMocks();
  safePostMessageMock.mockResolvedValue({ ok: true });
  resolveSlackDestinationMock.mockImplementation(
    async (_client: unknown, destination: string) =>
      destination.startsWith("U") ? `D_${destination}` : destination,
  );
});

afterEach(() => {
  if (originalFounderUserId === undefined) {
    delete process.env.FOUNDER_USER_ID;
  } else {
    process.env.FOUNDER_USER_ID = originalFounderUserId;
  }
  if (originalAuraOpsChannel === undefined) {
    delete process.env.AURA_OPS_CHANNEL;
  } else {
    process.env.AURA_OPS_CHANNEL = originalAuraOpsChannel;
  }
});

describe("resolveOpsNotificationTarget fallback ladder", () => {
  it("prefers AURA_OPS_CHANNEL over everything else", async () => {
    process.env.AURA_OPS_CHANNEL = "C_OPS";
    process.env.FOUNDER_USER_ID = "U_FOUNDER";

    const { resolveOpsNotificationTarget } = await import("./job-notifications.js");

    expect(resolveOpsNotificationTarget("U_REQUESTER")).toEqual({
      kind: "ops_channel",
      destination: "C_OPS",
    });
  });

  it("falls back to the founder DM when no ops channel is configured", async () => {
    process.env.FOUNDER_USER_ID = "U_FOUNDER";

    const { resolveOpsNotificationTarget } = await import("./job-notifications.js");

    expect(resolveOpsNotificationTarget("U_REQUESTER")).toEqual({
      kind: "founder_dm",
      destination: "U_FOUNDER",
    });
  });

  it("falls back to the requester DM as a last resort", async () => {
    const { resolveOpsNotificationTarget } = await import("./job-notifications.js");

    expect(resolveOpsNotificationTarget("U_REQUESTER")).toEqual({
      kind: "requester_dm",
      destination: "U_REQUESTER",
    });
  });

  it("keeps the system-owned (aura) skip semantics on the last-resort path", async () => {
    const { resolveOpsNotificationTarget } = await import("./job-notifications.js");

    expect(resolveOpsNotificationTarget("aura")).toBeNull();
    expect(resolveOpsNotificationTarget(null)).toBeNull();
    expect(resolveOpsNotificationTarget("  ")).toBeNull();
  });

  it("still resolves the ops channel for system-owned jobs", async () => {
    process.env.AURA_OPS_CHANNEL = "C_OPS";

    const { resolveOpsNotificationTarget } = await import("./job-notifications.js");

    expect(resolveOpsNotificationTarget("aura")).toEqual({
      kind: "ops_channel",
      destination: "C_OPS",
    });
  });
});

describe("sendJobOpsNotice", () => {
  const notice = {
    jobId: "job-1",
    jobName: "daily sync",
    requestedBy: "U_REQUESTER",
    text: "Job `daily sync` looked retryable, so I queued it to run again now.",
  };

  it("posts to the ops channel with job name and requester context", async () => {
    process.env.AURA_OPS_CHANNEL = "C_OPS";

    const { sendJobOpsNotice } = await import("./job-notifications.js");
    const result = await sendJobOpsNotice(notice);

    expect(result).toEqual({ ok: true, target: "ops_channel" });
    expect(resolveSlackDestinationMock).toHaveBeenCalledWith(expect.anything(), "C_OPS");
    expect(safePostMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "C_OPS",
        text: expect.stringContaining("`daily sync` (requested by <@U_REQUESTER>)"),
      }),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("posts to the founder DM when only FOUNDER_USER_ID is configured", async () => {
    process.env.FOUNDER_USER_ID = "U_FOUNDER";

    const { sendJobOpsNotice } = await import("./job-notifications.js");
    const result = await sendJobOpsNotice(notice);

    expect(result).toEqual({ ok: true, target: "founder_dm" });
    expect(safePostMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "D_U_FOUNDER",
        text: expect.stringContaining("<@U_REQUESTER>"),
      }),
    );
  });

  it("falls back to the requester DM with a warning when nothing is configured", async () => {
    const { sendJobOpsNotice } = await import("./job-notifications.js");
    const result = await sendJobOpsNotice(notice);

    expect(result).toEqual({ ok: true, target: "requester_dm" });
    expect(safePostMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "D_U_REQUESTER",
        text: notice.text,
      }),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("job_ops_notice_no_ops_destination_configured"),
      expect.objectContaining({ jobId: "job-1" }),
    );
  });

  it("skips system-owned jobs entirely when no ops destination is configured", async () => {
    const { sendJobOpsNotice } = await import("./job-notifications.js");
    const result = await sendJobOpsNotice({ ...notice, requestedBy: "aura" });

    expect(result).toEqual({ ok: false, target: null });
    expect(safePostMessageMock).not.toHaveBeenCalled();
  });

  it("reports failure without throwing when Slack posting fails", async () => {
    process.env.AURA_OPS_CHANNEL = "C_OPS";
    safePostMessageMock.mockRejectedValue(new Error("slack down"));

    const { sendJobOpsNotice } = await import("./job-notifications.js");
    const result = await sendJobOpsNotice(notice);

    expect(result).toEqual({ ok: false, target: "ops_channel" });
    expect(loggerMock.error).toHaveBeenCalled();
  });
});
