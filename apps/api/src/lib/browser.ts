import { logger } from "./logger.js";

/** Environment variables required for Browserbase integration */
export interface BrowserbaseConfig {
  apiKey: string;
  projectId: string;
}

/** Options for creating a new browser session */
export interface CreateSessionOptions {
  /** Custom browser settings */
  browserSettings?: {
    fingerprint?: {
      locales?: string[];
      viewport?: { width: number; height: number };
    };
  };
  /** Session timeout in seconds */
  timeoutSeconds?: number;
  /** Keep the session alive after the CDP connection drops (default true) */
  keepAlive?: boolean;
}

/** Browser session information */
export interface BrowserSession {
  id: string;
  projectId: string;
  status: string;
  createdAt: string;
  connectUrl: string;
  seleniumUrl: string;
}

/** Error response from Browserbase API */
export interface BrowserbaseError {
  error: string;
  message: string;
}

/**
 * Get Browserbase configuration from environment variables
 */
function getBrowserbaseConfig(): BrowserbaseConfig {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey) {
    throw new Error(
      "BROWSERBASE_API_KEY is not configured. Browser automation is not available.",
    );
  }

  if (!projectId) {
    throw new Error(
      "BROWSERBASE_PROJECT_ID is not configured. Browser automation is not available.",
    );
  }

  return { apiKey, projectId };
}

/**
 * Create a new browser session via Browserbase REST API
 */
export async function createSession(
  options: CreateSessionOptions = {},
): Promise<BrowserSession> {
  const config = getBrowserbaseConfig();

  const requestBody = {
    projectId: config.projectId,
    keepAlive: options.keepAlive ?? true,
    browserSettings: {
      fingerprint: {
        locales: ["en-US"],
        ...options.browserSettings?.fingerprint,
      },
      ...options.browserSettings,
    },
  };

  logger.info("Creating Browserbase session", {
    projectId: config.projectId,
    options,
  });

  try {
    const response = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bb-api-key": config.apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = (await response.json()) as BrowserbaseError;
      throw new Error(`Browserbase API error: ${error.message || error.error}`);
    }

    const session = (await response.json()) as BrowserSession;

    logger.info("Browserbase session created", {
      sessionId: session.id,
      status: session.status,
    });

    return session;
  } catch (error: any) {
    logger.error("Failed to create Browserbase session", {
      error: error.message,
    });
    throw new Error(`Failed to create browser session: ${error.message}`);
  }
}

/**
 * Connect to an existing browser session via Chrome DevTools Protocol
 */
export async function connectSession(sessionId: string): Promise<any> {
  const config = getBrowserbaseConfig();

  logger.info("Connecting to Browserbase session", { sessionId });

  try {
    // Dynamic import to keep Playwright as an optional dependency
    const { chromium } = await import("playwright-core");

    const connectUrl = `wss://connect.browserbase.com?apiKey=${config.apiKey}&sessionId=${sessionId}`;

    const browser = await chromium.connectOverCDP(connectUrl);

    logger.info("Connected to Browserbase session", { sessionId });

    return browser;
  } catch (error: any) {
    logger.error("Failed to connect to Browserbase session", {
      sessionId,
      error: error.message,
    });
    throw new Error(`Failed to connect to browser session: ${error.message}`);
  }
}

/**
 * Release a browser session, freeing up resources
 */
export async function releaseSession(sessionId: string): Promise<void> {
  const config = getBrowserbaseConfig();

  logger.info("Releasing Browserbase session", { sessionId });

  try {
    const response = await fetch(
      `https://api.browserbase.com/v1/sessions/${sessionId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bb-api-key": config.apiKey,
        },
        body: JSON.stringify({
          status: "REQUEST_RELEASE",
        }),
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as BrowserbaseError;
      throw new Error(`Browserbase API error: ${error.message || error.error}`);
    }

    logger.info("Browserbase session released", { sessionId });
  } catch (error: any) {
    logger.error("Failed to release Browserbase session", {
      sessionId,
      error: error.message,
    });
    // Don't throw here - we want to be resilient to release failures
    logger.warn("Continuing despite session release failure", { sessionId });
  }
}

/**
 * Convert a Buffer to base64 string for JSON serialization
 */
export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}