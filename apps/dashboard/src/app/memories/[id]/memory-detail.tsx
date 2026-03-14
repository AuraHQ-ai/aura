"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownContent } from "@/components/ui/markdown";
import { updateMemory } from "../actions";
import { ArrowLeft, Save, Pencil, X } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Memory } from "@schema";

interface MemoryWithUsers extends Omit<Memory, "searchVector"> {
  relatedUsers: { slackUserId: string; displayName: string }[];
}

export function MemoryDetail({ memory }: { memory: MemoryWithUsers }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [relevance, setRelevance] = useState(memory.relevanceScore);
  const [shareable, setShareable] = useState(memory.shareable);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await updateMemory(memory.id, { content, relevanceScore: relevance, shareable });
    setSaving(false);
    setEditing(false);
    router.refresh();
  }

  function handleCancel() {
    setContent(memory.content);
    setRelevance(memory.relevanceScore);
    setShareable(memory.shareable);
    setEditing(false);
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 flex items-center gap-2">
          <Badge variant="secondary">{memory.type}</Badge>
          <span className="text-sm text-muted-foreground">{formatDate(memory.createdAt)}</span>
        </div>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving} size="sm">
              <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Content</CardTitle></CardHeader>
        <CardContent>
          {editing ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="flex min-h-[calc(100vh-400px)] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            />
          ) : (
            <MarkdownContent content={content} className="max-w-3xl" />
          )}
        </CardContent>
      </Card>

      {editing && (
        <div className="grid gap-3 sm:grid-cols-3">
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
      )}

      {!editing && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader><CardTitle className="text-sm">Relevance Score</CardTitle></CardHeader>
            <CardContent>
              <span className="text-sm">{memory.relevanceScore.toFixed(1)}</span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Shareable</CardTitle></CardHeader>
            <CardContent>
              <span className="text-sm">{memory.shareable ? "Shareable across channels" : "Private"}</span>
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
      )}
    </>
  );
}
