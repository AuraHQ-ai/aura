import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getStats() {
  return apiGet<{
    notes: number;
    memories: number;
    users: number;
    activeJobs: number;
    errorsLast24h: number;
    recentErrors: Array<{
      id: string;
      errorName: string;
      errorCode: string | null;
      timestamp: Date;
      resolved: boolean;
    }>;
    recentExecutions: Array<{
      id: string;
      jobId: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      trigger: string;
    }>;
  }>("/stats");
}

export default async function DashboardPage() {
  const stats = await getStats();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Overview</h1>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
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
            <div className="text-xl font-bold">{stats.errorsLast24h}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
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
                  <div key={err.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate">{err.errorName}</span>
                      {err.errorCode && <Badge variant="outline" className="shrink-0">{err.errorCode}</Badge>}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground shrink-0">
                      {err.resolved && <Badge variant="success">Resolved</Badge>}
                      <span className="text-xs whitespace-nowrap">{formatDate(err.timestamp)}</span>
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
                  <div key={exec.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        className="shrink-0"
                        variant={
                          exec.status === "completed" ? "success" :
                          exec.status === "failed" ? "destructive" :
                          "secondary"
                        }
                      >
                        {exec.status}
                      </Badge>
                      <span className="text-muted-foreground truncate">{exec.trigger}</span>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
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
