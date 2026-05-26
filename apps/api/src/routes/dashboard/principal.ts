import type { Context } from "hono";

export type DashboardAuthType = "jwt" | "service";

export interface DashboardPrincipal {
  authType: DashboardAuthType;
  slackUserId?: string;
  role: "admin" | "power_user" | string;
}

const PRINCIPAL_KEY = "dashboardPrincipal";

export function setDashboardPrincipal(c: Context, principal: DashboardPrincipal): void {
  c.set(PRINCIPAL_KEY as never, principal as never);
}

export function getDashboardPrincipal(c: Context): DashboardPrincipal | undefined {
  return c.get(PRINCIPAL_KEY as never) as DashboardPrincipal | undefined;
}

export function isDashboardAdmin(principal: DashboardPrincipal | undefined): boolean {
  return principal?.role === "admin";
}

export function isDashboardService(principal: DashboardPrincipal | undefined): boolean {
  return principal?.authType === "service";
}

export function canAuditAllMemories(principal: DashboardPrincipal | undefined): boolean {
  return isDashboardAdmin(principal) || isDashboardService(principal);
}

export type MemoryScope = "mine" | "all";

export function getEffectiveMemoryScope(
  principal: DashboardPrincipal | undefined,
  requestedScope: string | undefined,
): MemoryScope {
  if (!canAuditAllMemories(principal)) return "mine";
  if (requestedScope === "mine" && principal?.slackUserId) return "mine";
  return "all";
}
