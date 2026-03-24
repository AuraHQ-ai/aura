// TODO: Migrate to DB-backed roles via hasRole() once dashboard auth supports async checks.
// For now this remains a sync env-var check used by the dashboard auth callback.

export function isAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  if (userId === "aura") return true;
  const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (adminIds.length === 0) return false;
  return adminIds.includes(userId);
}
