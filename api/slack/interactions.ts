import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel serverless function entry point for Slack interactive payloads.
 * Handles dropdown changes from the App Home settings tab.
 */
export const POST = handle(app);
