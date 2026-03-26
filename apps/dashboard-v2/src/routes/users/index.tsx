import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import { cn, formatDate } from "@/lib/utils";
import { useState } from "react";
import { Search } from "lucide-react";

interface User {
  id: string;
  slackUserId: string;
  displayName: string;
  interactionCount: number;
  lastInteractionAt: string | null;
  createdAt: string;
  personId: string | null;
  jobTitle: string | null;
}

const PAGE_SIZE = 100;

function UsersPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["users", search, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: User[]; total: number }>(`/users?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  if (error && !data)
    return (
      <div className="text-destructive text-sm">
        Failed to load users: {error.message}
      </div>
    );

  const users = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Users</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search users..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="pl-9"
        />
      </div>

      <div className={cn("rounded-xl border overflow-x-auto transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <Table className="min-w-[700px]">
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
            {isLoading ? (
              <TableRowsSkeleton columns={6} />
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  No users found
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id ?? user.slackUserId}>
                  <TableCell>
                    <Link
                      to="/users/$slackUserId"
                      params={{ slackUserId: user.slackUserId }}
                      className="font-medium hover:underline"
                    >
                      {user.displayName}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {user.slackUserId}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {user.jobTitle || "—"}
                  </TableCell>
                  <TableCell>{user.interactionCount}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(user.lastInteractionAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(user.createdAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />
    </div>
  );
}

export const Route = createFileRoute("/users/")({
  component: UsersPage,
});
