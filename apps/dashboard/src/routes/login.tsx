import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function LoginPage() {
  const returnTo = window.location.pathname === "/login" ? "/" : window.location.pathname;
  const origin = window.location.origin;

  const loginUrl = `/api/dashboard/auth/login?returnTo=${encodeURIComponent(returnTo)}&origin=${encodeURIComponent(origin)}`;

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className="max-w-sm w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Aura Dashboard</CardTitle>
          <p className="text-sm text-muted-foreground">
            Sign in with your Slack account to continue.
          </p>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full" size="lg">
            <a href={loginUrl}>
              Sign in with Slack
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/login")({
  component: LoginPage,
});
