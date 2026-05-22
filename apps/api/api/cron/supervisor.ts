import { handle } from "hono/vercel";
import app from "../../src/app.js";

/**
 * Webhook-triggered job supervisor.
 * Runs in a separate Vercel invocation from the worker that persisted the outcome.
 */
export const POST = handle(app);
