export function makeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function benchWorkspaceId(runId: string): string {
  return `bench-${runId}`;
}
