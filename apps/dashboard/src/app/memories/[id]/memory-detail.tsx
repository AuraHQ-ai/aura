"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { updateMemory } from "../actions";
import { ArrowLeft, Save } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Memory } from "@schema";

interface MemoryWithUsers extends Omit<Memory, "searchVector"> {
  relatedUsers: { slackUserId: string; displayName: string }[];
}

export function MemoryDetail({ memory }: { memory: MemoryWithUsers }) {
  const router = useRouter();
  const [content, setContent] = useState(memory.content);
  const [relevance, setRelevance] = useState(memory.relevanceScore);
  const [shareable, setShareable] = useState(memory.shareable);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await updateMemory(memory.id, { content, relevanceScore: relevance, shareable });
    setSaving(false);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <Link href="/memories">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="flex-1 flex items-center gap-2">
          <Badge variant="secondary">{memory.type}</Badge>
          <span className="text-sm text-muted-foreground">{formatDate(memory.createdAt)}</span>
        </div>
        <Button onClick={handleSave} disabled={saving} size="sm">
          <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Content</CardTitle></CardHeader>
        <CardContent>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-sm">Relevance Score</CardTitle></CardHeader>
          <CardContent>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={relevance}
              onChange={(e) => setRelevance(parseFloat(e.target.value))}
              className="w-full"
            />
            <span className="text-sm text-muted-foreground">{relevance.toFixed(1)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Shareable</CardTitle></CardHeader>
          <CardContent>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={shareable === 1}
                onChange={(e) => setShareable(e.target.checked ? 1 : 0)}
              />
              <span className="text-sm">{shareable ? "Shareable across channels" : "Private"}</span>
            </label>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Related Users</CardTitle></CardHeader>
          <CardContent>
            {memory.relatedUsers.length === 0 ? (
              <span className="text-sm text-muted-foreground">None</span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {memory.relatedUsers.map((u) => (
                  <Badge key={u.slackUserId} variant="outline">{u.displayName}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
