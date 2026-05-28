const FILE_ATTACHMENT_FALLBACK = "What can you tell me about this file?";

export function buildMessageText(
  contextText: string,
  hasFiles: boolean,
  voiceTranscripts: string[],
): string {
  if (voiceTranscripts.length > 0) {
    const voiceNoteText = `Voice note: "${voiceTranscripts.join("\n\n")}"`;
    const userText = contextText.trim();
    return userText ? `${voiceNoteText}\n\n${userText}` : voiceNoteText;
  }

  return contextText || (hasFiles ? FILE_ATTACHMENT_FALLBACK : "");
}
