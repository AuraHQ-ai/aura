"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pagination } from "@/components/pagination";
import { formatDate, truncate } from "@/lib/utils";
import { createNote, deleteNote } from "./actions";
import { Plus, Trash2, Search } from "lucide-react";
import type { Note } from "@schema";

export function NotesTable({ notes, total, page, pageSize }: { notes: Note[]; total: number; page: number; pageSize: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showCreate, setShowCreate] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [newTopic, setNewTopic] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState("knowledge");
  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");

  function handleSearch(value: string) {
    setSearchValue(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("search", value);
    } else {
      params.delete("search");
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  async function handleCreate() {
    if (!newTopic || !newContent) return;
    await createNote({ topic: newTopic, content: newContent, category: newCategory });
    setShowCreate(false);
    setNewTopic("");
    setNewContent("");
    setNewCategory("knowledge");
    router.refresh();
  }

  async function handleDelete() {
    if (!deleteId) return;
    await deleteNote(deleteId);
    setDeleteId(null);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search notes..."
            value={searchValue}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> New Note
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Topic</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {notes.map((note) => (
            <TableRow key={note.id}>
              <TableCell>
                <Link href={`/notes/${note.id}`} className="font-medium hover:underline">
                  {truncate(note.topic, 60)}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{note.category}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(note.updatedAt)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(note.expiresAt)}</TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" onClick={() => setDeleteId(note.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {notes.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                No notes found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Pagination total={total} pageSize={pageSize} page={page} />

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogHeader>
          <DialogTitle>Create Note</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input placeholder="Topic" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} />
          <textarea
            placeholder="Content (markdown)"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            className="flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
          <Input placeholder="Category" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>Delete Note</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">Are you sure you want to delete this note? This action cannot be undone.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete}>Delete</Button>
        </div>
      </Dialog>
    </>
  );
}
