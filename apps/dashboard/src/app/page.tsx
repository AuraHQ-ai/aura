import { db } from "@/lib/db";
import { notes, memories, userProfiles, jobs, errorEvents, jobExecutions } from "@schema";
import { count, eq, sql, desc, gte } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getStats() {
  const [notesCount] = await db.select({ value: count() }).from(notes);
  const [memoriesCount] = await db.select({ value: count() }).from(memories);
  const [usersCount] = await db.select({ value: count() }).from(userProfiles);
  const [activeJobsCount] = await db
    .select({ value: count() })
    .from(jobs)
    .where(eq(jobs.enabled, 1));

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recentErrorsCount] = await db
    .select({ value: count() })
    .from(errorEvents)
    .where(gte(errorEvents.timestamp, oneDayAgo));

  const recentErrors = await db
    .select({
      id: errorEvents.id,
      errorName: errorEvents.errorName,
      errorCode: errorEvents.errorCode,
      timestamp: errorEvents.timestamp,
      resolved: errorEvents.resolved,
    })
    .from(errorEvents)
    .orderBy(desc(errorEvents.timestamp))
    .limit(5);

  const recentExecutions = await db
    .select({
      id: jobExecutions.id,
      jobId: jobExecutions.jobId,
      status: jobExecutions.status,
      startedAt: jobExecutions.startedAt,
      finishedAt: jobExecutions.finishedAt,
      trigger: jobExecutions.trigger,
    })
    .from(jobExecutions)
    .orderBy(desc(jobExecutions.startedAt))
    .limit(5);

  return {
    notes: notesCount.value,
    memories: memoriesCount.value,
    users: usersCount.value,
    activeJobs: activeJobsCount.value,
    recentErrorsCount: recentErrorsCount.value,
    recentErrors,
    recentExecutions,
  };
}

export default async function DashboardPage() {
  const stats = await getStats();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Overview</h1>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{stats.notes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Memories</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{stats.memories}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Users</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{stats.users}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{stats.activeJobs}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Errors (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{stats.recentErrorsCount}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Errors</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.recentErrors.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent errors</p>
            ) : (
              <div className="space-y-3">
                {stats.recentErrors.map((err) => (
                  <div key={err.id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{err.errorName}</span>
                      {err.errorCode && <Badge variant="outline">{err.errorCode}</Badge>}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      {err.resolved && <Badge variant="success">Resolved</Badge>}
                      <span className="text-xs">{formatDate(err.timestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Job Executions</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.recentExecutions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent executions</p>
            ) : (
              <div className="space-y-3">
                {stats.recentExecutions.map((exec) => (
                  <div key={exec.id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          exec.status === "completed" ? "success" :
                          exec.status === "failed" ? "destructive" :
                          "secondary"
                        }
                      >
                        {exec.status}
                      </Badge>
                      <span className="text-muted-foreground">{exec.trigger}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(exec.startedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
