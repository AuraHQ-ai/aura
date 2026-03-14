import { getConsumptionData } from "./actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConsumptionCharts } from "./consumption-charts";

import { formatCost } from "./utils";

export const dynamic = "force-dynamic";

export default async function ConsumptionPage() {
  const data = await getConsumptionData();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Consumption</h1>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Cost (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatCost(data.totals.totalCost)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Conversations (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{data.totals.conversations.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Daily Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatCost(data.totals.avgDailyCost)}</div>
          </CardContent>
        </Card>
      </div>

      <ConsumptionCharts data={data} />
    </div>
  );
}
