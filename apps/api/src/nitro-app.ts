/**
 * Nitro server entry — routes all HTTP traffic to the Hono app.
 *
 * Kept separate from src/index.ts because that file conditionally starts a
 * standalone @hono/node-server, which must not run inside nitro dev.
 */
import app from "./app.js";

export default app;
