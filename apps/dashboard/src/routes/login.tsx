import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSlackLoginUrl } from "@/lib/auth";

function getSafeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/api/")) {
    return "/";
  }
  return value;
}

function LoginPage() {
  const params = new URLSearchParams(window.location.search);
  const returnTo = getSafeReturnTo(params.get("returnTo"));
  const reason = params.get("reason");

  const loginUrl = getSlackLoginUrl(returnTo);
  const message = reason === "token_expired"
    ? "Your dashboard session expired. Sign in with Slack to continue."
    : "Sign in with your Slack account to continue.";

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className="max-w-sm w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Aura Dashboard</CardTitle>
          <p className="text-sm text-muted-foreground">
            {message}
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
