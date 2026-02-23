import { tool } from "ai";
import { z } from "zod";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";

/**
 * Create browser automation tools for the AI SDK.
 * Uses Browserbase (remote Chromium) + Playwright for web automation.
 * Admin-only.
 */
export function createBrowserTools(context?: ScheduleContext) {
  return {
    browse: tool({
      description:
        "Browse a web page using a remote Chromium browser (Browserbase + Playwright). Navigate to a URL, take a screenshot, and extract content (text, accessibility tree, or HTML). For multi-step interactive flows, write a Playwright script and run it via run_command instead. Admin-only.",
      inputSchema: z.object({
        url: z
          .string()
          .describe("URL to navigate to. E.g. 'https://example.com'"),
        session_id: z
          .string()
          .optional()
          .describe(
            "Reuse an existing Browserbase session for multi-step flows. Returned from previous browse calls.",
          ),
        screenshot: z
          .boolean()
          .default(true)
          .describe("Take a screenshot after navigation (default true)"),
        extract: z
          .enum(["text", "accessibility", "html"])
          .default("text")
          .describe(
            "What to extract from the page: 'text' (innerText), 'accessibility' (accessibility tree), 'html' (raw HTML). Default 'text'.",
          ),
        headers: z
          .record(z.string())
          .optional()
          .describe(
            "Custom HTTP headers to set (e.g. for Cloudflare bypass tokens)",
          ),
        stealth: z
          .boolean()
          .default(true)
          .describe("Enable anti-detection fingerprinting (default true)"),
        keep_alive: z
          .boolean()
          .default(false)
          .describe(
            "Keep the browser session alive after this call so it can be reused. Pass the returned session_id to a subsequent browse call to continue.",
          ),
        timeout_seconds: z
          .number()
          .min(5)
          .max(120)
          .default(30)
          .describe("Navigation timeout in seconds (default 30, max 120)"),
      }),
      execute: async ({
        url,
        session_id,
        screenshot,
        extract,
        headers,
        stealth,
        keep_alive,
        timeout_seconds,
      }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can use the browse tool.",
          };
        }

        if (!process.env.BROWSERBASE_API_KEY) {
          return {
            ok: false,
            error:
              "Browser automation is not available. BROWSERBASE_API_KEY is not configured.",
          };
        }

        if (!process.env.BROWSERBASE_PROJECT_ID) {
          return {
            ok: false,
            error:
              "Browser automation is not available. BROWSERBASE_PROJECT_ID is not configured.",
          };
        }

        const {
          createSession,
          connectSession,
          releaseSession,
        } = await import("../lib/browser.js");

        let sessionId = session_id;
        let ownsSession = false;

        try {
          if (!sessionId) {
            const session = await createSession({ stealth, keepAlive: keep_alive });
            sessionId = session.id;
            ownsSession = true;
          }

          const { browser, context: ctx, page } = await connectSession(
            sessionId,
          );

          const timeoutMs = timeout_seconds * 1000;
          const consoleErrors: string[] = [];

          page.on("console", (msg) => {
            if (msg.type() === "error") {
              consoleErrors.push(msg.text());
            }
          });

          if (headers) {
            await ctx.setExtraHTTPHeaders(headers);
          }

          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });

          const resultUrl = page.url();
          const resultTitle = await page.title();
          let screenshotBase64: string | undefined;
          let extractedContent: string | undefined;

          if (screenshot) {
            try {
              const buf = await page.screenshot({
                type: "png",
                fullPage: false,
                timeout: 10_000,
              });
              screenshotBase64 = buf.toString("base64");
            } catch (err: any) {
              logger.warn("browse: screenshot failed", {
                error: err.message,
              });
            }
          }

          if (extract) {
            try {
              if (extract === "text") {
                const text = await page.innerText("body").catch(() => "");
                extractedContent =
                  text.length > 16_000 ? text.slice(0, 16_000) + "\n…[truncated]" : text;
              } else if (extract === "accessibility") {
                const snapshot = await page.locator("body").ariaSnapshot();
                extractedContent =
                  snapshot.length > 16_000
                    ? snapshot.slice(0, 16_000) + "\n…[truncated]"
                    : snapshot;
              } else if (extract === "html") {
                const html = await page.content();
                extractedContent =
                  html.length > 16_000
                    ? html.slice(0, 16_000) + "\n…[truncated]"
                    : html;
              }
            } catch (err: any) {
              logger.warn("browse: content extraction failed", {
                extract,
                error: err.message,
              });
            }
          }

          try {
            await browser.close();
          } catch {
            // best-effort
          }

          if (!keep_alive) {
            releaseSession(sessionId).catch(() => {});
          }

          logger.info("browse tool completed", {
            url: resultUrl,
            sessionId,
            hasScreenshot: !!screenshotBase64,
          });

          return {
            ok: true,
            url: resultUrl,
            title: resultTitle,
            ...(screenshotBase64
              ? { screenshot_base64: screenshotBase64 }
              : {}),
            ...(extractedContent
              ? { extracted_content: extractedContent }
              : {}),
            session_id: sessionId,
            console_errors:
              consoleErrors.length > 0
                ? consoleErrors.slice(0, 20)
                : [],
          };
        } catch (error: any) {
          logger.error("browse tool failed", {
            url,
            sessionId,
            error: error.message,
          });

          if (sessionId && (ownsSession || !keep_alive)) {
            releaseSession(sessionId).catch(() => {});
          }

          if (error.message?.includes("Timeout")) {
            return {
              ok: false,
              error: `Navigation timed out after ${timeout_seconds}s. The page may be slow or blocking automated browsers. Try increasing timeout_seconds or enabling stealth mode.`,
              session_id: sessionId,
            };
          }

          if (
            error.message?.includes("net::ERR_") ||
            error.message?.includes("NS_ERROR_")
          ) {
            return {
              ok: false,
              error: `Network error: ${error.message}. The site may be down or blocking the request.`,
              session_id: sessionId,
            };
          }

          return {
            ok: false,
            error: `Browse failed: ${error.message}`,
            session_id: sessionId,
          };
        }
      },
    }),
  };
}
