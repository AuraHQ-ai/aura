"use client";

import { useState } from "react";
import Link from "next/link";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { Search } from "lucide-react";

interface UserRow {
  id: string;
  slackUserId: string;
  displayName: string;
  interactionCount: number;
  lastInteractionAt: Date | null;
  createdAt: Date;
  personId: string | null;
  jobTitle: string | null;
}

export function UsersTable({ users }: { users: UserRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = search
    ? users.filter((u) => u.displayName.toLowerCase().includes(search.toLowerCase()))
    : users;

  return (
    <>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search users..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slack ID</TableHead>
            <TableHead>Job Title</TableHead>
            <TableHead>Interactions</TableHead>
            <TableHead>Last Active</TableHead>
            <TableHead>Joined</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((user) => (
            <TableRow key={user.id}>
              <TableCell>
                <Link href={`/users/${user.slackUserId}`} className="font-medium hover:underline">
                  {user.displayName}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-sm text-muted-foreground">{user.slackUserId}</TableCell>
              <TableCell className="text-muted-foreground">{user.jobTitle || "—"}</TableCell>
              <TableCell>{user.interactionCount}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(user.lastInteractionAt)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(user.createdAt)}</TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No users found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}
