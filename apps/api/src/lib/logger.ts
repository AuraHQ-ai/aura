import fs from "node:fs";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/** Current minimum log level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Adjust the minimum log level at runtime. Used by long-running CLIs (e.g. the
 * memory bench) to temporarily quiet INFO noise, then restore the prior level.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Optional file sink. When set, every emitted (already level-filtered) line is
 * also appended to this file — used by the bench to capture a full `run.log`
 * even while the Ink dashboard owns the terminal. Off by default (no overhead
 * on the Vercel runtime); only the bench CLI opts in via `setLogFile`.
 */
let logStream: fs.WriteStream | null = null;

/** Begin appending every formatted log line to `path` (creates parent dirs). */
export function setLogFile(path: string): void {
  closeLogFile();
  fs.mkdirSync(path.replace(/\/[^/]*$/, ""), { recursive: true });
  logStream = fs.createWriteStream(path, { flags: "a" });
}

/** Stop and flush the file sink (if any). */
export function closeLogFile(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

function formatMessage(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): string {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

/**
 * Emit a fully-formatted line via the matching console method (warn/error →
 * stderr). When a TTY UI like Ink's `patchConsole` is mounted it intercepts
 * these writes and scrolls them above the live region automatically — no
 * manual cursor juggling needed. Also mirror to the file sink when active.
 */
function emit(
  level: LogLevel,
  consoleFn: (msg: string) => void,
  line: string,
): void {
  consoleFn(line);
  if (logStream) logStream.write(line + "\n");
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("debug")) {
      emit("debug", console.debug, formatMessage("debug", message, meta));
    }
  },

  info(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("info")) {
      emit("info", console.info, formatMessage("info", message, meta));
    }
  },

  warn(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("warn")) {
      emit("warn", console.warn, formatMessage("warn", message, meta));
    }
  },

  error(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("error")) {
      emit("error", console.error, formatMessage("error", message, meta));
    }
  },
};
