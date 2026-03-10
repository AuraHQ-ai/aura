"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, truncate } from "@/lib/utils";
import { deleteResource } from "./actions";
import { Search, Trash2 } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Resource } from "@schema";

export function ResourcesTable({ resources }: { resources: Resource[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filtered = search
    ? resources.filter((r) =>
        (r.title || r.url).toLowerCase().includes(search.toLowerCase()),
      )
    : resources;

  async function handleDelete() {
    if (!deleteId) return;
    await deleteResource(deleteId);
    setDeleteId(null);
    router.refresh();
  }

  return (
    <>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search resources..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Crawled</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((resource) => (
            <TableRow key={resource.id}>
              <TableCell>
                <Link href={`/resources/${resource.id}`} className="font-medium hover:underline">
                  {truncate(resource.title || resource.url, 60)}
                </Link>
              </TableCell>
              <TableCell><Badge variant="outline">{resource.source}</Badge></TableCell>
              <TableCell>
                <Badge variant={
                  resource.status === "ready" ? "success" :
                  resource.status === "error" ? "destructive" :
                  "warning"
                }>
                  {resource.status}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(resource.crawledAt)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(resource.updatedAt)}</TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" onClick={() => setDeleteId(resource.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No resources found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>Delete Resource</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">This action cannot be undone.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete}>Delete</Button>
        </div>
      </Dialog>
    </>
  );
}
