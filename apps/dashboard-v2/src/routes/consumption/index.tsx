import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageSkeleton } from "@/components/page-skeleton";

interface ConsumptionData {
  totalTokens: number;
  totalCost: number;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  byDay: Array<{
    date: string;
    tokens: number;
    cost: number;
  }>;
}

function ConsumptionPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["consumption"],
    queryFn: () => apiGet<ConsumptionData>("/consumption"),
  });

  if (isLoading) return <PageSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load consumption data: {error.message}</div>;
  if (!data) return null;

  const totalTokens = data.totalTokens ?? 0;
  const totalCost = data.totalCost ?? 0;
  const byModel = data.byModel ?? [];
  const byDay = data.byDay ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Consumption</h1>

      <div className="grid gap-3 grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{totalTokens.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">${totalCost.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage by Model</CardTitle>
        </CardHeader>
        <CardContent>
          {byModel.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage data</p>
          ) : (
            <div className="space-y-3">
              {byModel.map((entry) => (
                <div key={entry.model} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{entry.model}</span>
                  <div className="flex items-center gap-4 text-muted-foreground">
                    <span>{((entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)).toLocaleString()} tokens</span>
                    <span>${(entry.cost ?? 0).toFixed(4)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 flex items-center justify-center text-muted-foreground text-sm border border-dashed rounded-md">
            Chart visualization — connect to a running API to see real data
          </div>
          {byDay.length > 0 && (
            <div className="mt-4 space-y-2">
              {byDay.slice(0, 7).map((day) => (
                <div key={day.date} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{day.date}</span>
                  <div className="flex items-center gap-4">
                    <span>{(day.tokens ?? 0).toLocaleString()} tokens</span>
                    <span className="text-muted-foreground">${(day.cost ?? 0).toFixed(4)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/consumption/")({
  component: ConsumptionPage,
});
