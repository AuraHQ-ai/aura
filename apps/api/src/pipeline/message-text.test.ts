import { describe, expect, it } from "vitest";

import { buildMessageText } from "./message-text.js";

describe("buildMessageText", () => {
  it("uses the voice transcript as the message body for audio-only messages", () => {
    expect(buildMessageText("", true, ["turn on the kitchen lights"])).toBe(
      'Voice note: "turn on the kitchen lights"',
    );
  });

  it("appends typed text after the voice note transcript", () => {
    expect(buildMessageText("also make it brief", true, ["summarize this"])).toBe(
      'Voice note: "summarize this"\n\nalso make it brief',
    );
  });

  it("keeps the file fallback for non-audio file-only messages", () => {
    expect(buildMessageText("", true, [])).toBe("What can you tell me about this file?");
  });

  it("formats transcription failures as voice-note text", () => {
    expect(buildMessageText("", true, ["[transcription failed: OPENAI_API_KEY is not set]"])).toBe(
      'Voice note: "[transcription failed: OPENAI_API_KEY is not set]"',
    );
  });
});
