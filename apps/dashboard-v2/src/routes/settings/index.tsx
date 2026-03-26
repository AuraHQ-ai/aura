import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageSkeleton } from "@/components/page-skeleton";

interface SettingsData {
  items: Array<{
    key: string;
    value: string;
    description: string | null;
    updatedAt: string;
  }>;
}

function SettingsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsData>("/settings"),
  });

  if (isLoading) return <PageSkeleton rows={8} />;
  if (error) return <div className="text-destructive text-sm">Failed to load settings: {error.message}</div>;

  const settings = data?.items ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      {settings.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No settings configured
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {settings.map((setting) => (
            <Card key={setting.key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium font-mono">{setting.key}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <div className="text-sm">{setting.value}</div>
                {setting.description && (
                  <div className="text-xs text-muted-foreground">{setting.description}</div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
});
