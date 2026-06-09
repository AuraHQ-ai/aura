import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel Cron handler for the eval funnel (Machine A).
 * Triggered by vercel.json cron schedule (overnight).
 */
export const GET = handle(app);
