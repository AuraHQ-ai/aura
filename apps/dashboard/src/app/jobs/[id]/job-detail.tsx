"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ArrowLeft } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Job, JobExecution } from "@schema";

type ExecutionWithTrace = JobExecution & { costUsd: string | null; conversationTraceId: string | null };

interface JobData {
  job: Job;
  executions: ExecutionWithTrace[];
}

export function JobDetail({ data }: { data: JobData }) {
  const { job, executions } = data;

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/jobs">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">{job.name}</h1>
          <p className="text-sm text-muted-foreground truncate">{job.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
      </div>

      <Tabs defaultValue="executions">
        <TabsList>
          <TabsTrigger value="executions">Executions</TabsTrigger>
          <TabsTrigger value="playbook">Playbook</TabsTrigger>
        </TabsList>

        <TabsContent value="executions">
          <div className="overflow-x-auto">
            <Table className="min-w-[700px]">
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
                  <TableRow key={exec.id} className={exec.conversationTraceId ? "cursor-pointer hover:bg-muted/50" : ""}>
                    <TableCell className="text-sm">
                      {exec.conversationTraceId ? (
                        <Link
                          href={`/conversations/${exec.conversationTraceId}`}
                          className="hover:underline"
                        >
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
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      No executions yet
                    </TableCell>
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
    </>
  );
}
