import { tool } from "ai";
import { z } from "zod";
import type { Browser, Page, BrowserContext } from "playwright-core";
import {
  createSession,
  connectSession,
  releaseSession,
  bufferToBase64,
} from "../lib/browser.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Truncate text to a max length */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...(truncated, ${text.length} chars total)`;
}

/** Extract text content from a page */
async function extractContent(
  page: Page,
  mode: "text" | "accessibility" | "html",
): Promise<string> {
  switch (mode) {
    case "text":
      return truncate((await page.innerText("body")).trim(), 16000);
    case "html":
      return truncate(await page.content(), 32000);
    case "accessibility": {
      const snapshot = await page.accessibility.snapshot();
      return truncate(JSON.stringify(snapshot, null, 2), 16000);
    }
    default:
      return truncate((await page.innerText("body")).trim(), 16000);
  }
}

/** Collect console errors during page operations */
function setupConsoleCollector(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });
  return errors;
}

// ── Tool Definition ──────────────────────────────────────────────────────────

export function createBrowserTools(context?: ScheduleContext) {
  return {
    browse: tool({
      description:
        "Browse a webpage or automate browser interactions using Browserbase (remote Chromium). Two modes: (1) Simple: provide a URL to navigate, take screenshots, and extract content. (2) Code: provide Playwright JS code for multi-step automation (variables `page`, `context`, `browser` are available). Returns screenshot as base64, extracted text/HTML/accessibility tree, and console errors. Admin-only.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe(
            "URL to navigate to (simple mode). Mutually exclusive with code.",
          ),
        code: z
          .string()
          .optional()
          .describe(
            "Playwright JS code to execute (code mode). Has access to `page`, `context`, `browser`. Must return a result object or void. Mutually exclusive with url.",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "Reuse an existing Browserbase session ID. If omitted, a new session is created and released after.",
          ),
        screenshot: z
          .boolean()
          .default(true)
          .describe("Take a screenshot after navigation (default true)."),
        extract: z
          .enum(["text", "accessibility", "html"])
          .optional()
          .describe(
            "Extract content from the page. 'text' = innerText, 'accessibility' = a11y tree, 'html' = raw HTML.",
          ),
        headers: z
          .record(z.string())
          .optional()
          .describe("Custom HTTP headers to set before navigation."),
        stealth: z
          .boolean()
          .default(true)
          .describe("Use stealth fingerprinting (default true)."),
        timeout_seconds: z
          .number()
          .min(5)
          .max(120)
          .default(30)
          .describe(
            "Timeout for the operation in seconds (default 30, max 120).",
          ),
      }),
      execute: async ({
        url,
        code,
        session_id,
        screenshot,
        extract,
        headers,
        stealth,
        timeout_seconds,
      }) => {
        // Admin-only check
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can use the browse tool.",
          };
        }

        // Validate input
        if (!url && !code) {
          return {
            ok: false,
            error:
              "Provide either 'url' (simple mode) or 'code' (code mode).",
          };
        }
        if (url && code) {
          return {
            ok: false,
            error:
              "Provide either 'url' or 'code', not both.",
          };
        }

        if (
          !process.env.BROWSERBASE_API_KEY ||
          !process.env.BROWSERBASE_PROJECT_ID
        ) {
          return {
            ok: false,
            error:
              "Browser automation is not available. BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be configured.",
          };
        }

        const ownSession = !session_id;
        let browser: Browser | null = null;
        let currentSessionId = session_id || "";

        try {
          // Create or reuse session
          if (ownSession) {
            const session = await createSession({
              browserSettings: stealth
                ? { fingerprint: { locales: ["en-US"] } }
                : undefined,
            });
            currentSessionId = session.id;
          }

          // Connect to the session
          browser = await connectSession(currentSessionId);
          const contexts = browser.contexts();
          const browserContext: BrowserContext =
            contexts.length > 0 ? contexts[0] : await browser.newContext();
          const pages = browserContext.pages();
          const page: Page =
            pages.length > 0 ? pages[0] : await browserContext.newPage();

          // Set custom headers if provided
          if (headers) {
            await page.setExtraHTTPHeaders(headers);
          }

          const consoleErrors = setupConsoleCollector(page);

          const timeoutMs = timeout_seconds * 1000;

          let resultUrl = page.url();
          let resultTitle = "";
          let screenshotBase64: string | undefined;
          let extractedContent: string | undefined;
          let codeResult: unknown;

          if (url) {
            // ── Simple mode ──
            logger.info("browse tool: navigating", {
              url,
              sessionId: currentSessionId,
            });

            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });

            // Wait a bit for dynamic content
            await page.waitForTimeout(1000);

            resultUrl = page.url();
            resultTitle = await page.title();

            if (screenshot) {
              const buf = await page.screenshot({
                type: "png",
                fullPage: false,
              });
              screenshotBase64 = bufferToBase64(buf);
            }

            if (extract) {
              extractedContent = await extractContent(page, extract);
            }
          } else if (code) {
            // ── Code mode ──
            logger.info("browse tool: executing code", {
              codeLength: code.length,
              sessionId: currentSessionId,
            });

            // Create a sandboxed function with page, context, browser available
            const AsyncFunction = Object.getPrototypeOf(
              async function () {},
            ).constructor;
            const fn = new AsyncFunction(
              "page",
              "context",
              "browser",
              code,
            );

            codeResult = await Promise.race([
              fn(page, browserContext, browser),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("Code execution timed out")),
                  timeoutMs,
                ),
              ),
            ]);

            resultUrl = page.url();
            resultTitle = await page.title();

            if (screenshot) {
              const buf = await page.screenshot({
                type: "png",
                fullPage: false,
              });
              screenshotBase64 = bufferToBase64(buf);
            }

            if (extract) {
              extractedContent = await extractContent(page, extract);
            }
          }

          const result: Record<string, unknown> = {
            ok: true,
            url: resultUrl,
            title: resultTitle,
            session_id: currentSessionId,
            console_errors: consoleErrors.slice(0, 10),
          };

          if (screenshotBase64) {
            result.screenshot_base64 = screenshotBase64;
          }
          if (extractedContent) {
            result.extracted_content = extractedContent;
          }
          if (codeResult !== undefined) {
            result.code_result =
              typeof codeResult === "string"
                ? codeResult
                : JSON.stringify(codeResult);
          }

          logger.info("browse tool: completed", {
            url: resultUrl,
            title: resultTitle,
            sessionId: currentSessionId,
            hasScreenshot: !!screenshotBase64,
            hasExtract: !!extractedContent,
            consoleErrors: consoleErrors.length,
          });

          return result;
        } catch (error: any) {
          logger.error("browse tool: failed", {
            error: error.message,
            sessionId: currentSessionId,
          });
          return {
            ok: false,
            error: error.message,
            session_id: currentSessionId || undefined,
          };
        } finally {
          // Clean up
          if (browser) {
            try {
              await browser.close();
            } catch {
              // ignore close errors
            }
          }
          if (ownSession && currentSessionId) {
            await releaseSession(currentSessionId);
          }
        }
      },
    }),
  };
}
