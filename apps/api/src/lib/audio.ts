import { logger } from "./logger.js";

/**
 * Transcribe an audio file using OpenAI's Whisper API.
 * Uses direct fetch to avoid adding the openai package as a dependency.
 */
export async function transcribeAudio(
  data: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const formData = new FormData();
  formData.append("file", new Blob([data], { type: mimeType }), filename);
  formData.append("model", "whisper-1");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown");
    throw new Error(
      `Whisper API error: HTTP ${response.status} — ${errorBody}`,
    );
  }

  const result = (await response.json()) as { text: string };

  logger.info("Whisper transcription complete", {
    filename,
    mimeType,
    textLength: result.text.length,
    textPreview: result.text.substring(0, 100),
  });

  return result.text;
}
