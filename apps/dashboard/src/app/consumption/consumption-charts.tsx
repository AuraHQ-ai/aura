"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { ConsumptionData } from "./actions";
import { formatCost } from "./utils";

export function ConsumptionCharts({ data }: { data: ConsumptionData }) {
  const chartData = data.dailyCost.map((d) => ({
    date: d.date.slice(5),
    cost: Number(d.cost.toFixed(4)),
    conversations: d.conversations,
  }));

  const totalTokens =
    data.tokenBreakdown.cacheRead +
    data.tokenBreakdown.cacheWrite +
    data.tokenBreakdown.uncached +
    data.tokenBreakdown.output;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Cost (30 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" />
                <YAxis className="text-xs" tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg)",
                    border: "1px solid var(--col-border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value: number, name: string) =>
                    name === "Cost" ? [`$${value.toFixed(4)}`, name] : [value.toLocaleString(), name]
                  }
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.1}
                  name="Cost"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No cost data yet. Costs will appear after conversations with cost tracking are processed.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by User</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="w-[100px] text-right">Interactive</TableHead>
                  <TableHead className="w-[100px] text-right">Jobs</TableHead>
                  <TableHead className="w-[100px] text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.perUser.map((u) => (
                  <TableRow key={u.userId}>
                    <TableCell className="font-medium">{u.displayName || u.userId}</TableCell>
                    <TableCell className="text-right">{formatCost(u.interactiveCost)}</TableCell>
                    <TableCell className="text-right">{formatCost(u.jobCost)}</TableCell>
                    <TableCell className="text-right font-medium">{formatCost(u.totalCost)}</TableCell>
                  </TableRow>
                ))}
                {data.perUser.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-4">No data</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost by Job</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead className="w-[140px]">Creator</TableHead>
                  <TableHead className="w-[80px] text-right">Runs</TableHead>
                  <TableHead className="w-[100px] text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.perJob.map((j, i) => (
                  <TableRow key={`${j.jobName}-${j.creatorName}-${i}`}>
                    <TableCell className="font-medium">{j.jobName || "Unknown"}</TableCell>
                    <TableCell>{j.creatorName || "—"}</TableCell>
                    <TableCell className="text-right">{j.executionCount}</TableCell>
                    <TableCell className="text-right font-medium">{formatCost(j.totalCost)}</TableCell>
                  </TableRow>
                ))}
                {data.perJob.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-4">No data</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {totalTokens > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Token Breakdown (30 days)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-4">
              <div>
                <p className="text-sm text-muted-foreground">Cache Read</p>
                <p className="text-lg font-semibold">{data.tokenBreakdown.cacheRead.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Cache Write</p>
                <p className="text-lg font-semibold">{data.tokenBreakdown.cacheWrite.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Uncached Input</p>
                <p className="text-lg font-semibold">{data.tokenBreakdown.uncached.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Output</p>
                <p className="text-lg font-semibold">{data.tokenBreakdown.output.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
