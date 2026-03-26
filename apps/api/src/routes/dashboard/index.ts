import { dashboardAuthApp } from "./auth.js";
import { dashboardChatApp } from "./chat.js";
import { dashboardStatsApp } from "./stats.js";
import { dashboardNotesApp } from "./notes.js";
import { dashboardMemoriesApp } from "./memories.js";
import { dashboardUsersApp } from "./users.js";
import { dashboardConversationsApp } from "./conversations.js";
import { dashboardErrorsApp } from "./errors.js";
import { dashboardJobsApp } from "./jobs.js";
import { dashboardCredentialsApp } from "./credentials.js";
import { dashboardResourcesApp } from "./resources.js";
import { dashboardConsumptionApp } from "./consumption.js";
import { dashboardSettingsApp } from "./settings.js";
import { dashboardModelsApp } from "./models.js";
import { createDashboardApp } from "./schemas.js";
import { jwtVerify } from "jose";

export const dashboardApp = createDashboardApp();

const PUBLIC_AUTH_PATHS = ["/auth/login", "/auth/callback", "/auth/token-receive"];

dashboardApp.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname.replace("/api/dashboard", "");
  if (PUBLIC_AUTH_PATHS.some((p) => path.startsWith(p))) {
    return next();
  }

  // Try Bearer token from header (dashboard-v2 SPA)
  const authHeader = c.req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // Try session cookie (dashboard v1 / Next.js)
  const cookieToken = token || c.req.header("cookie")?.match(/aura_session=([^;]+)/)?.[1] || "";

  const candidate = token || cookieToken;
  if (!candidate) return c.json({ error: "Unauthorized" }, 401);

  // Accept static DASHBOARD_API_SECRET (Next.js dashboard server-side calls)
  const apiSecret = process.env.DASHBOARD_API_SECRET;
  if (apiSecret && candidate === apiSecret) {
    return next();
  }

  // Accept JWT signed with DASHBOARD_SESSION_SECRET (user sessions)
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
  if (sessionSecret) {
    try {
      const { payload } = await jwtVerify(
        candidate,
        new TextEncoder().encode(sessionSecret),
      );
      if (payload.purpose) throw new Error("Invalid token type");
      c.set("userId" as never, payload.slackUserId as never);
      c.set("userName" as never, payload.name as never);
      return next();
    } catch {
      // JWT verification failed — fall through to 401
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

dashboardApp.route("/auth", dashboardAuthApp);
dashboardApp.route("/chat", dashboardChatApp);
dashboardApp.route("/stats", dashboardStatsApp);
dashboardApp.route("/notes", dashboardNotesApp);
dashboardApp.route("/memories", dashboardMemoriesApp);
dashboardApp.route("/users", dashboardUsersApp);
dashboardApp.route("/conversations", dashboardConversationsApp);
dashboardApp.route("/errors", dashboardErrorsApp);
dashboardApp.route("/jobs", dashboardJobsApp);
dashboardApp.route("/credentials", dashboardCredentialsApp);
dashboardApp.route("/resources", dashboardResourcesApp);
dashboardApp.route("/consumption", dashboardConsumptionApp);
dashboardApp.route("/settings", dashboardSettingsApp);
dashboardApp.route("/models", dashboardModelsApp);

dashboardApp.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: { title: "Aura Dashboard API", version: "1.0.0" },
});
