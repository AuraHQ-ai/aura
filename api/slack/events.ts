import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel serverless function entry point for Slack events.
 * Delegates to the Hono app.
 */
export const POST = handle(app);
export const GET = handle(app);
