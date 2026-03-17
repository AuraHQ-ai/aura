import { Hono } from "hono";
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

export const dashboardApp = new Hono();

dashboardApp.use("*", async (c, next) => {
  const secret = process.env.DASHBOARD_API_SECRET;
  if (!secret) return c.json({ error: "DASHBOARD_API_SECRET not configured" }, 503);
  if (c.req.header("authorization") !== `Bearer ${secret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

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
