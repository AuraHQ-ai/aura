import { getError } from "../actions";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ErrorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const error = await getError(id);
  if (!error) return notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/errors">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-base font-semibold">{error.errorName}</h1>
          <p className="text-sm text-muted-foreground">{formatDate(error.timestamp)}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {error.errorCode && <Badge variant="outline">{error.errorCode}</Badge>}
          <Badge variant={error.resolved ? "success" : "destructive"}>
            {error.resolved ? "Resolved" : "Open"}
          </Badge>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Error Message</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm">{error.errorMessage}</p>
        </CardContent>
      </Card>

      {error.stackTrace && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Stack Trace</CardTitle></CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[400px]">
              {error.stackTrace}
            </pre>
          </CardContent>
        </Card>
      )}

      {error.context && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Context</CardTitle></CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[400px]">
              {JSON.stringify(error.context, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {error.userId && (
          <Card>
            <CardHeader><CardTitle className="text-sm">User</CardTitle></CardHeader>
            <CardContent>
              <Link href={`/users/${error.userId}`} className="font-mono text-sm hover:underline">
                {error.userId}
              </Link>
            </CardContent>
          </Card>
        )}
        {error.channelId && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Channel</CardTitle></CardHeader>
            <CardContent><span className="font-mono text-sm">{error.channelId}</span></CardContent>
          </Card>
        )}
        {error.channelType && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Channel Type</CardTitle></CardHeader>
            <CardContent><Badge variant="outline">{error.channelType}</Badge></CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
