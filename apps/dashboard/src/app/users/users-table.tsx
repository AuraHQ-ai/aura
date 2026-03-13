"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
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

interface Props {
  users: UserRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function UsersTable({ users, total, page, pageSize }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");

  function handleSearch(value: string) {
    setSearchValue(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("search", value);
    } else {
      params.delete("search");
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search users..."
          value={searchValue}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[160px]">Name</TableHead>
            <TableHead className="w-[120px]">Slack ID</TableHead>
            <TableHead>Job Title</TableHead>
            <TableHead className="w-[100px]">Interactions</TableHead>
            <TableHead className="w-[140px]">Last Active</TableHead>
            <TableHead className="w-[140px]">Joined</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
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
          {users.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No users found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Pagination total={total} pageSize={pageSize} page={page} />
    </>
  );
}
