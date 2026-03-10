"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { toggleJobEnabled } from "./actions";
import { Search } from "lucide-react";
import type { Job } from "@schema";

export function JobsTable({ jobs }: { jobs: Job[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");

  const filtered = search
    ? jobs.filter((j) => j.name.toLowerCase().includes(search.toLowerCase()))
    : jobs;

  async function handleToggle(id: string, currentEnabled: number) {
    await toggleJobEnabled(id, currentEnabled === 0);
    router.refresh();
  }

  return (
    <>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search jobs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Executions</TableHead>
            <TableHead>Last Run</TableHead>
            <TableHead>Priority</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((job) => (
            <TableRow key={job.id}>
              <TableCell>
                <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                  {job.name}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant={job.status === "completed" ? "success" : job.status === "failed" ? "destructive" : "secondary"}>
                  {job.status}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-sm text-muted-foreground">{job.cronSchedule || "—"}</TableCell>
              <TableCell>
                <button
                  onClick={() => handleToggle(job.id, job.enabled)}
                  className={`relative h-5 w-9 rounded-full transition-colors cursor-pointer ${
                    job.enabled ? "bg-emerald-500" : "bg-muted"
                  }`}
                >
                  <span
                    className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      job.enabled ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </TableCell>
              <TableCell>{job.executionCount}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(job.lastExecutedAt)}</TableCell>
              <TableCell><Badge variant="outline">{job.priority}</Badge></TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No jobs found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}
