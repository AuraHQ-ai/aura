import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

function UnauthorizedPage() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-destructive mb-2" />
          <CardTitle>Unauthorized</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <p className="text-sm text-muted-foreground">
            You don&apos;t have permission to access this dashboard. Please sign in with a valid Slack account.
          </p>
          <Button asChild>
            <Link to="/">Go Home</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/unauthorized")({
  component: UnauthorizedPage,
});
