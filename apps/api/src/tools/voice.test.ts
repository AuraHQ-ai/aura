import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  selectRows: [] as Array<Array<{ count: string | number; oldestCreatedAt: Date | string | null }>>,
  insertValues: vi.fn(),
  onConflictDoNothing: vi.fn(),
}));

const getConfigMock = vi.hoisted(() => vi.fn());
const resolveCredentialValueMock = vi.hoisted(() => vi.fn());
const resolveSlackDestinationMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: any) => config,
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => dbMocks.selectRows.shift() ?? []),
      })),
    })),
    insert: vi.fn(() => ({
      values: dbMocks.insertValues.mockImplementation(() => ({
        onConflictDoNothing: dbMocks.onConflictDoNothing.mockResolvedValue(undefined),
      })),
    })),
  },
}));

vi.mock("../lib/settings.js", () => ({
  getConfig: getConfigMock,
}));

vi.mock("../lib/credentials.js", () => ({
  resolveCredentialValue: resolveCredentialValueMock,
}));

vi.mock("./slack.js", () => ({
  resolveSlackDestination: resolveSlackDestinationMock,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createVoiceTools } from "./voice.js";

describe("send_voice_note quota", () => {
  beforeEach(() => {
    vi.useRealTimers();
    dbMocks.selectRows = [];
    dbMocks.insertValues.mockClear();
    dbMocks.onConflictDoNothing.mockClear();
    getConfigMock.mockImplementation(async (key: string, fallback?: string) => {
      if (key === "voice_note_hourly_limit") return "2";
      if (key === "elevenlabs_voice_id") return "voice-default";
      return fallback ?? "";
    });
    resolveCredentialValueMock.mockResolvedValue("elevenlabs-key");
    resolveSlackDestinationMock.mockResolvedValue("C123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/text-to-speech/")) {
          return new Response("mp3-bytes", { status: 200 });
        }
        return new Response("", { status: 200 });
      }),
    );
  });

  it("returns remaining quota after a successful voice note", async () => {
    dbMocks.selectRows = [
      [{ count: "1", oldestCreatedAt: new Date("2026-06-09T21:00:00Z") }],
      [{ count: "2", oldestCreatedAt: new Date("2026-06-09T21:00:00Z") }],
    ];
    const slackClient = {
      files: {
        getUploadURLExternal: vi.fn().mockResolvedValue({
          upload_url: "https://uploads.slack.test/F123",
          file_id: "F123",
        }),
        completeUploadExternal: vi.fn().mockResolvedValue({
          files: [{ permalink: "https://slack.test/files/F123" }],
        }),
      },
    };
    const tools = createVoiceTools(slackClient as any, {
      userId: "U123",
      channelId: "C123",
      threadTs: "171234.000100",
    });

    const result = await tools.send_voice_note.execute({
      text: "hello from Aura",
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: "F123",
      file_url: "https://slack.test/files/F123",
      quota: {
        used: 2,
        limit: 2,
        remaining: 0,
        window: "1h",
      },
    });
    expect(dbMocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "voice_note_F123",
      direction: "voice_note",
      slackUserId: "U123",
      metadata: expect.objectContaining({
        voiceId: "voice-default",
        channelId: "C123",
        threadTs: "171234.000100",
      }),
    }));
  });

  it("rejects over-limit voice notes with retry-after metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T21:30:00Z"));
    dbMocks.selectRows = [
      [{ count: "2", oldestCreatedAt: new Date("2026-06-09T21:00:00Z") }],
    ];
    const fetchMock = vi.mocked(fetch);
    const slackClient = {
      files: {
        getUploadURLExternal: vi.fn(),
        completeUploadExternal: vi.fn(),
      },
    };
    const tools = createVoiceTools(slackClient as any, {
      userId: "U123",
      channelId: "C123",
      threadTs: "171234.000100",
    });

    const result = await tools.send_voice_note.execute({
      text: "this should be rejected",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Rate limit: too many voice notes in the last hour.",
      quota: {
        used: 2,
        limit: 2,
        remaining: 0,
        window: "1h",
        retry_after_seconds: 1800,
        retry_after_at: "2026-06-09T22:00:00.000Z",
      },
      retry_after_seconds: 1800,
      retry_after_at: "2026-06-09T22:00:00.000Z",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMocks.insertValues).not.toHaveBeenCalled();
  });
});
