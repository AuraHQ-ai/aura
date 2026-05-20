/**
 * Scan stdout/stderr for a JSON error envelope that signals a logical failure
 * even when the process exited 0. Matches:
 *   - {"error": "..."}  or  {"error": {...}}
 *   - {"ok": false, ...}
 * Only top-level JSON lines are inspected (one per line).
 */
export function detectScriptOutputError(output: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

      if ("error" in parsed && parsed.error) {
        const msg = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
        return msg;
      }

      if (parsed.ok === false) {
        const msg = typeof parsed.error === "string" ? parsed.error : "Script returned {ok: false}";
        return msg;
      }
    } catch {
      // not valid JSON — skip
    }
  }
  return null;
}
