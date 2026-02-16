import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel Cron handler for the heartbeat.
 * Runs every 5 minutes, evaluates and executes due jobs,
 * cleans up expired plans, flags abandoned work.
 */
export const GET = handle(app);
