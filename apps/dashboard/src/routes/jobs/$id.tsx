import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { ArrowLeft, Play, BookOpen, Plus, X } from "lucide-react";
import { useState } from "react";

type JobModelCategory = "main" | "fast" | "medium" | "escalation";

const JOB_MODEL_OPTIONS: JobModelCategory[] = ["main", "fast", "medium", "escalation"];

/** Env var NAMES only (never values) — standard POSIX-style identifier. */
const ENV_VAR_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface JobPatch {
  enabled?: boolean;
  model?: JobModelCategory | null;
  promptMode?: "full" | "task" | null;
  envAllowlist?: string[] | null;
}

interface Execution {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  error: string | null;
  costUsd: string | null;
  conversationTraceId: string | null;
}

interface JobData {
  job: {
    id: string;
    name: string;
    description: string | null;
    cronSchedule: string | null;
    enabled: boolean;
    status: string;
    priority: string;
    executionCount: number;
    lastExecutedAt: string | null;
    playbook: string | null;
    model: JobModelCategory | null;
    promptMode: "full" | "task" | null;
    envAllowlist: string[] | null;
  };
  executions: Execution[];
}

function JobDetailPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const [newEnvVar, setNewEnvVar] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["jobs", id],
    queryFn: () => apiGet<JobData>(`/jobs/${id}`),
  });

  const updateMutation = useMutation({
    mutationFn: (patch: JobPatch) => apiPatch(`/jobs/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load job: {error.message}</div>;
  if (!data) return null;

  const { job, executions } = data;

  const trimmedEnvVar = newEnvVar.trim();
  const canAddEnvVar =
    ENV_VAR_NAME_REGEX.test(trimmedEnvVar) &&
    !(job.envAllowlist ?? []).includes(trimmedEnvVar);

  function addEnvVar() {
    if (!canAddEnvVar) return;
    updateMutation.mutate({
      envAllowlist: [...(job.envAllowlist ?? []), trimmedEnvVar],
    });
    setNewEnvVar("");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/jobs"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">{job.name}</h1>
          {job.description && <p className="text-sm text-muted-foreground truncate">{job.description}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={job.enabled}
            onCheckedChange={(checked) => updateMutation.mutate({ enabled: checked })}
            disabled={updateMutation.isPending}
          />
          <Badge variant={job.enabled ? "success" : "secondary"}>
            {job.enabled ? "Enabled" : "Disabled"}
          </Badge>
          <Badge variant="outline">{job.status}</Badge>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader><CardTitle>Schedule</CardTitle></CardHeader>
          <CardContent>
            <span className="font-mono text-[13px]">{job.cronSchedule || "One-shot"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Executions</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{job.executionCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Priority</CardTitle></CardHeader>
          <CardContent>
            <Badge variant="outline">{job.priority}</Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Last Run</CardTitle></CardHeader>
          <CardContent>
            <span className="text-sm">{formatDate(job.lastExecutedAt)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Model</CardTitle></CardHeader>
          <CardContent>
            <Select
              value={job.model ?? "__default"}
              onValueChange={(v) =>
                updateMutation.mutate({
                  model: v === "__default" ? null : (v as JobModelCategory),
                })
              }
              disabled={updateMutation.isPending}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">medium (default)</SelectItem>
                {JOB_MODEL_OPTIONS.map((category) => (
                  <SelectItem key={category} value={category}>{category}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Prompt Mode</CardTitle></CardHeader>
          <CardContent>
            <Select
              value={job.promptMode ?? "__default"}
              onValueChange={(v) =>
                updateMutation.mutate({
                  promptMode: v === "__default" ? null : (v as "full" | "task"),
                })
              }
              disabled={updateMutation.isPending}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">full (default)</SelectItem>
                <SelectItem value="full">full</SelectItem>
                <SelectItem value="task">task</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card className="col-span-2">
          <CardHeader><CardTitle className="text-sm">Env Allowlist</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {job.envAllowlist === null ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  Full inheritance — job sees every env var its caller scope allows.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateMutation.mutate({ envAllowlist: [] })}
                  disabled={updateMutation.isPending}
                >
                  Restrict
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {job.envAllowlist.map((name) => (
                    <Badge key={name} variant="secondary" className="font-mono text-xs gap-1">
                      {name}
                      <button
                        onClick={() =>
                          updateMutation.mutate({
                            envAllowlist: job.envAllowlist!.filter((n) => n !== name),
                          })
                        }
                        disabled={updateMutation.isPending}
                        className="cursor-pointer hover:text-destructive"
                        aria-label={`Remove ${name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  {job.envAllowlist.length === 0 && (
                    <span className="text-sm text-muted-foreground">Empty — no env vars allowed.</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={newEnvVar}
                    onChange={(e) => setNewEnvVar(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addEnvVar();
                    }}
                    placeholder="ENV_VAR_NAME"
                    className="h-8 max-w-[240px] font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addEnvVar}
                    disabled={updateMutation.isPending || !canAddEnvVar}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => updateMutation.mutate({ envAllowlist: null })}
                    disabled={updateMutation.isPending}
                    className="ml-auto text-muted-foreground"
                  >
                    Reset to full inheritance
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Env var names only — values are never shown.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="executions">
        <TabsList>
          <TabsTrigger value="executions"><Play /> Executions</TabsTrigger>
          <TabsTrigger value="playbook"><BookOpen /> Playbook</TabsTrigger>
        </TabsList>

        <TabsContent value="executions">
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Started</TableHead>
                  <TableHead className="w-[140px]">Finished</TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                  <TableHead className="w-[80px]">Cost</TableHead>
                  <TableHead className="w-[80px]">Trigger</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.map((exec) => (
                  <TableRow key={exec.id}>
                    <TableCell className="text-sm">
                      {exec.conversationTraceId ? (
                        <Link to="/conversations/$id" params={{ id: exec.conversationTraceId }} className="hover:underline">
                          {formatDate(exec.startedAt)}
                        </Link>
                      ) : (
                        formatDate(exec.startedAt)
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(exec.finishedAt)}</TableCell>
                    <TableCell>
                      <Badge variant={
                        exec.status === "completed" ? "success" :
                        exec.status === "failed" ? "destructive" :
                        "secondary"
                      }>
                        {exec.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm font-mono text-muted-foreground">
                      {exec.costUsd ? `$${parseFloat(exec.costUsd).toFixed(4)}` : "—"}
                    </TableCell>
                    <TableCell className="text-sm">{exec.trigger}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {exec.error || "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {executions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No executions yet</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="playbook">
          <Card>
            <CardContent className="pt-4">
              {job.playbook ? (
                <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[500px]">
                  {job.playbook}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No playbook defined.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export const Route = createFileRoute("/jobs/$id")({
  component: JobDetailPage,
});
