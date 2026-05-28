import { handle } from "hono/vercel";
import app from "../../src/app.js";

/** Vercel Cron entry for nightly memory benchmark. */
export const GET = handle(app);
