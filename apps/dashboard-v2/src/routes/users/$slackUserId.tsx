import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSkeleton } from "@/components/page-skeleton";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface UserDetail {
  slackUserId: string;
  name: string;
  email: string | null;
  isAdmin: boolean;
  isActive: boolean;
  timezone: string | null;
  title: string | null;
}

function UserDetailPage() {
  const { slackUserId } = Route.useParams();
  const { data: user, isLoading, error } = useQuery({
    queryKey: ["users", slackUserId],
    queryFn: () => apiGet<UserDetail>(`/users/${slackUserId}`),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load user: {error.message}</div>;
  if (!user) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/users">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{user.name}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">User Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <span className="text-sm text-muted-foreground">Slack User ID</span>
            <div className="font-mono text-sm">{user.slackUserId}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Email</span>
            <div>{user.email ?? "—"}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Role</span>
            <div>{user.isAdmin ? <Badge variant="default">Admin</Badge> : <Badge variant="secondary">User</Badge>}</div>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Status</span>
            <div>{user.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Inactive</Badge>}</div>
          </div>
          {user.timezone && (
            <div>
              <span className="text-sm text-muted-foreground">Timezone</span>
              <div>{user.timezone}</div>
            </div>
          )}
          {user.title && (
            <div>
              <span className="text-sm text-muted-foreground">Title</span>
              <div>{user.title}</div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/users/$slackUserId")({
  component: UserDetailPage,
});
