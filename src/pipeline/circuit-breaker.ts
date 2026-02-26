/**
 * Circuit breaker for detecting semantic repetition in run_command tool calls.
 *
 * Catches "same purpose, same failure" patterns by:
 * 1. Normalizing shell commands (stripping comments, collapsing whitespace)
 * 2. Tracking consecutive run_command failures
 * 3. Detecting repeated API endpoint URLs across failures
 */

const CIRCUIT_BREAKER_THRESHOLD = 3;

const CIRCUIT_BREAKER_FAILURE =
  "CIRCUIT BREAKER: {count} consecutive run_command calls have failed. " +
  "Stop retrying — the command is not working. Analyze the error output, " +
  "report the failure to the user, and suggest a different approach. " +
  "Do NOT retry the same or similar command.";

const CIRCUIT_BREAKER_SIMILAR =
  "CIRCUIT BREAKER: You are retrying semantically identical commands " +
  "(differing only in comments or whitespace) that keep failing. " +
  "STOP immediately. The command does not work. Report the failure to the user.";

const CIRCUIT_BREAKER_ENDPOINT =
  "CIRCUIT BREAKER: The API endpoint {endpoint} has failed in {count} " +
  "consecutive commands. It is likely down, rate-limited, or the request " +
  "is malformed. STOP calling this endpoint. Report the failure to the user.";

export interface CommandFailureRecord {
  normalizedCommand: string;
  endpoints: string[];
}

/**
 * Normalize a shell command for semantic comparison.
 * Strips shell comments (respecting quotes), collapses whitespace, trims.
 */
export function normalizeCommand(cmd: string): string {
  return cmd
    .split("\n")
    .map((line) => {
      let result = "";
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "#" && !inSingle && !inDouble) break;
        result += ch;
      }
      return result;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract API endpoint URLs from a shell command.
 * Returns normalized endpoints (origin + pathname, no query/fragment).
 */
export function extractEndpoints(cmd: string): string[] {
  const urlRegex = /https?:\/\/[^\s'"\\)}>]+/gi;
  const matches = cmd.match(urlRegex) || [];
  const endpoints = new Set<string>();
  for (const url of matches) {
    try {
      const u = new URL(url);
      endpoints.add(u.origin + u.pathname);
    } catch {
      endpoints.add(url);
    }
  }
  return [...endpoints];
}

export function detectCircuitBreaker(failures: CommandFailureRecord[]): {
  triggered: boolean;
  message?: string;
} {
  if (failures.length < CIRCUIT_BREAKER_THRESHOLD) {
    return { triggered: false };
  }

  const recent = failures.slice(-CIRCUIT_BREAKER_THRESHOLD);

  const lastNormalized = recent[recent.length - 1].normalizedCommand;
  if (lastNormalized && recent.every((f) => f.normalizedCommand === lastNormalized)) {
    return { triggered: true, message: CIRCUIT_BREAKER_SIMILAR };
  }

  const lastEndpoints = recent[recent.length - 1].endpoints;
  for (const ep of lastEndpoints) {
    if (recent.every((f) => f.endpoints.includes(ep))) {
      return {
        triggered: true,
        message: CIRCUIT_BREAKER_ENDPOINT
          .replace("{endpoint}", ep)
          .replace("{count}", String(recent.length)),
      };
    }
  }

  return {
    triggered: true,
    message: CIRCUIT_BREAKER_FAILURE.replace("{count}", String(failures.length)),
  };
}
