import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/page-skeleton";
import { Input } from "@/components/ui/input";
import { useState } from "react";

interface User {
  slackUserId: string;
  name: string;
  email: string | null;
  isAdmin: boolean;
  isActive: boolean;
}

function UsersPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["users", search],
    queryFn: () => apiGet<{ items: User[]; total: number }>(`/users?search=${encodeURIComponent(search)}`),
  });

  if (isLoading) return <TableSkeleton columns={5} />;
  if (error) return <div className="text-destructive text-sm">Failed to load users: {error.message}</div>;

  const users = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Users</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? 0} total</span>
      </div>
      <Input
        placeholder="Search users..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">No users found</TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.slackUserId}>
                  <TableCell>
                    <Link to="/users/$slackUserId" params={{ slackUserId: user.slackUserId }} className="font-medium hover:underline">
                      {user.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{user.email ?? "—"}</TableCell>
                  <TableCell>
                    {user.isAdmin ? <Badge variant="default">Admin</Badge> : <Badge variant="secondary">User</Badge>}
                  </TableCell>
                  <TableCell>
                    {user.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Inactive</Badge>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/users/")({
  component: UsersPage,
});
