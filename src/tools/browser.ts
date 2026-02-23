import { tool } from "ai";
import { z } from "zod";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";

/**
 * Create browser automation tools for the AI SDK.
 * Uses Browserbase (remote Chromium) + Playwright for web automation.
 * Admin-only — runs arbitrary Playwright code in code mode.
 */
export function createBrowserTools(context?: ScheduleContext) {
  return {
    browse: tool({
      description:
        "Browse a web page using a remote Chromium browser (Browserbase + Playwright). Two modes: (1) Simple mode — navigate to a URL, optionally take a screenshot and extract content. (2) Code mode — execute arbitrary Playwright JS code for multi-step flows (login, click, fill forms, scrape). Admin-only.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe(
            "URL to navigate to (simple mode). E.g. 'https://example.com'",
          ),
        code: z
          .string()
          .optional()
          .describe(
            "Playwright JS code to execute (code mode). Has access to `page`, `context`, and `browser` variables. Return a value to include it in the result. E.g. 'await page.goto(\"https://example.com\"); return await page.title();'",
          ),
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
        code,
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

        if (!url && !code) {
          return {
            ok: false,
            error:
              "Provide either `url` (simple mode) or `code` (code mode).",
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

          let resultUrl = page.url();
          let resultTitle = "";
          let screenshotBase64: string | undefined;
          let extractedContent: string | undefined;
          let codeResult: unknown;

          if (code) {
            const vm = await import("node:vm");
            const sandbox = { page, context: ctx, browser };
            const wrappedCode = `(async () => { ${code} })()`;
            const codePromise = vm.runInNewContext(wrappedCode, sandbox, {
              timeout: timeoutMs,
              filename: "browse-code-mode",
            });
            let timer: ReturnType<typeof setTimeout>;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Timeout ${timeout_seconds}s exceeded`)),
                timeoutMs,
              );
            });
            try {
              codeResult = await Promise.race([codePromise, timeoutPromise]);
            } finally {
              clearTimeout(timer!);
            }

            resultUrl = page.url();
            try {
              resultTitle = await page.title();
            } catch {
              resultTitle = "";
            }
          } else if (url) {
            // Simple mode: navigate and extract
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });

            resultUrl = page.url();
            resultTitle = await page.title();
          }

          // Screenshot
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

          // Content extraction (only in simple mode, or after code mode)
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

          // Disconnect Playwright (doesn't close the session)
          try {
            await browser.close();
          } catch {
            // best-effort
          }

          if (!keep_alive) {
            releaseSession(sessionId).catch(() => {});
          }

          logger.info("browse tool completed", {
            mode: code ? "code" : "simple",
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
            ...(codeResult !== undefined
              ? { code_result: String(codeResult) }
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
