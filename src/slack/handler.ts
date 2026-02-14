/**
 * Slack Bolt event handler registration.
 *
 * This module provides an alternative integration path using @slack/bolt's
 * App class. The primary integration is done directly in app.ts via Hono.
 * This is kept for reference or for deployments that prefer Bolt's receiver model.
 */

import type { App } from "@slack/bolt";
import { runPipeline } from "../pipeline/index.js";
import { logger } from "../lib/logger.js";

/**
 * Register Slack event handlers on a Bolt app instance.
 *
 * Listens for:
 * - `message` events (DMs and channel messages)
 * - `app_mention` events (@Aura mentions in channels)
 */
export function registerHandlers(
  app: App,
  botUserId: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  app.event("message", async ({ event, client }) => {
    logger.debug("Received message event", {
      channel: event.channel,
      type: event.type,
    });

    await runPipeline({
      event,
      client,
      botUserId,
      waitUntil,
    });
  });

  app.event("app_mention", async ({ event, client }) => {
    logger.debug("Received app_mention event", {
      channel: event.channel,
      user: event.user,
    });

    await runPipeline({
      event,
      client,
      botUserId,
      waitUntil,
    });
  });

  logger.info("Slack event handlers registered");
}
