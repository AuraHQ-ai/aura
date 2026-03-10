import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel Cron handler for daily memory consolidation.
 * Triggered by vercel.json cron schedule.
 */
export const GET = handle(app);
