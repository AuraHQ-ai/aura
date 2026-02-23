import { logger } from "./logger.js";

const BROWSERBASE_API_URL = "https://api.browserbase.com/v1";

interface SessionOptions {
  stealth?: boolean;
  proxy?: boolean;
  timeout?: number;
  keepAlive?: boolean;
}

interface BrowserbaseSession {
  id: string;
  status: string;
}

function getApiKey(): string {
  const key = process.env.BROWSERBASE_API_KEY;
  if (!key) throw new Error("BROWSERBASE_API_KEY is not configured.");
  return key;
}

function getProjectId(): string {
  const id = process.env.BROWSERBASE_PROJECT_ID;
  if (!id) throw new Error("BROWSERBASE_PROJECT_ID is not configured.");
  return id;
}

/**
 * Create a new Browserbase session via REST API.
 */
export async function createSession(
  options?: SessionOptions,
): Promise<BrowserbaseSession> {
  const apiKey = getApiKey();
  const projectId = getProjectId();

  const browserSettings: Record<string, unknown> = {
    fingerprint: {
      locales: ["en-US"],
    },
  };

  if (options?.stealth === false) {
    delete browserSettings.fingerprint;
  }

  const body: Record<string, unknown> = {
    projectId,
    browserSettings,
  };

  if (options?.keepAlive) {
    body.keepAlive = true;
  }

  if (options?.proxy) {
    (body as any).proxies = true;
  }

  const response = await fetch(`${BROWSERBASE_API_URL}/sessions`, {
    method: "POST",
    headers: {
      "x-bb-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Browserbase session creation failed: HTTP ${response.status} — ${text}`,
    );
  }

  const session = (await response.json()) as BrowserbaseSession;
  logger.info("Browserbase session created", { sessionId: session.id });
  return session;
}

/**
 * Connect Playwright to an existing Browserbase session via CDP.
 * Returns { browser, context, page } for use in automation.
 * Uses dynamic import so playwright-core only loads when needed.
 */
export async function connectSession(sessionId: string) {
  const apiKey = getApiKey();
  const { chromium } = await import("playwright-core");

  const wsEndpoint = `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${sessionId}`;
  const browser = await chromium.connectOverCDP(wsEndpoint, {
    timeout: 30_000,
  });

  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  logger.info("Connected to Browserbase session via CDP", { sessionId });
  return { browser, context, page };
}

/**
 * Release (close) a Browserbase session.
 */
export async function releaseSession(sessionId: string): Promise<void> {
  const apiKey = getApiKey();
  const projectId = getProjectId();

  try {
    const response = await fetch(
      `${BROWSERBASE_API_URL}/sessions/${sessionId}`,
      {
        method: "POST",
        headers: {
          "x-bb-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn("Browserbase session release failed", {
        sessionId,
        status: response.status,
        body: text,
      });
    } else {
      logger.info("Browserbase session released", { sessionId });
    }
  } catch (error: any) {
    logger.warn("Browserbase session release error", {
      sessionId,
      error: error.message,
    });
  }
}
