"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { updateNote } from "../actions";
import { ArrowLeft, Save } from "lucide-react";
import type { Note } from "@schema";

export function NoteEditor({ note }: { note: Note }) {
  const router = useRouter();
  const [topic, setTopic] = useState(note.topic);
  const [content, setContent] = useState(note.content);
  const [category, setCategory] = useState(note.category);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await updateNote(note.id, { topic, content, category });
    setSaving(false);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-4">
        <Link href="/notes">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="flex-1">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="text-lg font-semibold border-0 px-0 focus-visible:ring-0 shadow-none"
          />
        </div>
        <Badge variant="secondary">{category}</Badge>
        <Button onClick={handleSave} disabled={saving} size="sm">
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-2 block">Category</label>
          <Input value={category} onChange={(e) => setCategory(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-muted-foreground mb-2 block">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex min-h-[400px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono"
        />
      </div>
    </>
  );
}
