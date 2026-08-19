import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audioMocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
}));

vi.mock("./audio.js", () => ({
  transcribeAudio: audioMocks.transcribeAudio,
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { downloadEventFiles } from "./files.js";

function stubSlackDownload(data: Uint8Array = new Uint8Array([1, 2, 3])) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    }),
  );
}

describe("downloadEventFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSlackDownload();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns audio transcripts separately from content parts", async () => {
    audioMocks.transcribeAudio.mockResolvedValue("hello from a voice note");

    const result = await downloadEventFiles(
      {
        files: [
          {
            url_private_download: "https://slack.test/voice.ogg",
            mimetype: "audio/ogg",
            name: "voice.ogg",
            size: 123,
          },
        ],
      },
      "xoxb-token",
    );

    expect(result.parts).toEqual([]);
    expect(result.transcripts).toEqual(["hello from a voice note"]);
    expect(audioMocks.transcribeAudio).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "audio/ogg",
      "voice.ogg",
    );
  });

  it("returns a failure transcript when audio transcription fails", async () => {
    audioMocks.transcribeAudio.mockRejectedValue(new Error("OPENAI_API_KEY is not set"));

    const result = await downloadEventFiles(
      {
        files: [
          {
            url_private_download: "https://slack.test/voice.ogg",
            mimetype: "audio/ogg",
            name: "voice.ogg",
            size: 123,
          },
        ],
      },
      "xoxb-token",
    );

    expect(result.parts).toEqual([]);
    expect(result.transcripts).toEqual([
      "[transcription failed: OPENAI_API_KEY is not set]",
    ]);
  });

  it("keeps non-audio files as content parts without transcripts", async () => {
    stubSlackDownload(new TextEncoder().encode("hello file"));

    const result = await downloadEventFiles(
      {
        files: [
          {
            url_private_download: "https://slack.test/note.txt",
            mimetype: "text/plain",
            name: "note.txt",
            size: 10,
          },
        ],
      },
      "xoxb-token",
    );

    expect(result.transcripts).toEqual([]);
    expect(result.parts).toEqual([
      { type: "text", text: "[File: note.txt]\nhello file" },
    ]);
  });
});
