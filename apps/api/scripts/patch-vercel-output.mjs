/**
 * Post-process the Nitro-generated Build Output API config:
 *
 * 1. SPA fallback — the previous filesystem-functions deploy used a
 *    vercel.json rewrite of /(.*) → /index.html. With the Build Output API,
 *    routing comes from .vercel/output/config.json, so we insert an
 *    equivalent fallback (after the filesystem handler, before the catch-all
 *    to the server function) for non-API browser navigation paths.
 *
 * 2. Crons — declared in the Build Output config so they survive the move
 *    away from vercel.json-driven builds.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(root, ".vercel/output/config.json");

const config = JSON.parse(readFileSync(configPath, "utf8"));
config.routes ??= [];

const SPA_FALLBACK = {
  src: "^/(?!api/|slack/|health$|\\.well-known/).*",
  dest: "/index.html",
};

const alreadyPatched = config.routes.some(
  (route) => route && route.dest === "/index.html",
);

if (!alreadyPatched) {
  // Insert right before the final catch-all (which routes to the server
  // function), so static assets and API routes keep their behavior.
  const catchAllIndex = config.routes.findIndex(
    (route) => route && route.src === "/(.*)",
  );
  if (catchAllIndex === -1) {
    config.routes.push(SPA_FALLBACK);
  } else {
    config.routes.splice(catchAllIndex, 0, SPA_FALLBACK);
  }
}

config.crons = [
  { path: "/api/cron/consolidate", schedule: "0 4 * * *" },
  { path: "/api/cron/heartbeat", schedule: "*/30 * * * *" },
];

writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log("Patched .vercel/output/config.json (SPA fallback + crons)");
