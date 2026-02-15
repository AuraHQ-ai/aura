import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel Cron handler for the scheduled actions sweeper.
 * Runs every 5 minutes, processes due actions.
 */
export const GET = handle(app);
