import { describe, expect, it } from "vitest";
import {
  canAuditAllMemories,
  getEffectiveMemoryScope,
  type DashboardPrincipal,
} from "./principal.js";

describe("dashboard principal memory access", () => {
  const admin: DashboardPrincipal = {
    authType: "jwt",
    slackUserId: "U_ADMIN",
    role: "admin",
  };
  const powerUser: DashboardPrincipal = {
    authType: "jwt",
    slackUserId: "U_POWER",
    role: "power_user",
  };
  const service: DashboardPrincipal = {
    authType: "service",
    role: "admin",
  };
  const nonAdminService: DashboardPrincipal = {
    authType: "service",
    role: "power_user",
  };

  it("allows admins and service callers to audit all memories", () => {
    expect(canAuditAllMemories(admin)).toBe(true);
    expect(canAuditAllMemories(service)).toBe(true);
    expect(canAuditAllMemories(nonAdminService)).toBe(true);
  });

  it("does not allow power users to audit all memories", () => {
    expect(canAuditAllMemories(powerUser)).toBe(false);
  });

  it("defaults admins and service callers to all scope", () => {
    expect(getEffectiveMemoryScope(admin, undefined)).toBe("all");
    expect(getEffectiveMemoryScope(service, undefined)).toBe("all");
  });

  it("allows admins with a Slack identity to request mine scope", () => {
    expect(getEffectiveMemoryScope(admin, "mine")).toBe("mine");
  });

  it("forces non-admin users to mine scope", () => {
    expect(getEffectiveMemoryScope(powerUser, "all")).toBe("mine");
    expect(getEffectiveMemoryScope(powerUser, undefined)).toBe("mine");
  });
});
