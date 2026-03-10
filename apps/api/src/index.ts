/**
 * Aura v0 — Entry point
 *
 * For local development: runs the Hono app on port 3000.
 * For Vercel: the app is exported from app.ts and used by the API route.
 */

import app from "./app.js";

const port = parseInt(process.env.PORT || "3000");

// Local development server
if (process.env.NODE_ENV !== "production") {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`\n  🔮 Aura is listening on http://localhost:${port}\n`);
  });
}

export default app;
