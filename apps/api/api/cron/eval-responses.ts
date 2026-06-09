import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel Cron handler for the overnight eval response batch judge.
 * Triggered by vercel.json cron schedule.
 */
export const GET = handle(app);
