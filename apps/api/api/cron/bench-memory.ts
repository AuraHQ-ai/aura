import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Vercel Cron entry for the nightly memory benchmark.
 * Triggered by vercel.json `crons` at 04:30 UTC.
 */
export const GET = handle(app);
