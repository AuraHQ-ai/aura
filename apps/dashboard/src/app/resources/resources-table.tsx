"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { formatDate, truncate } from "@/lib/utils";
import { deleteResource } from "./actions";
import { Search, Trash2 } from "lucide-react";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Resource } from "@schema";

interface Props {
  resources: Resource[];
  total: number;
  page: number;
  pageSize: number;
}

export function ResourcesTable({ resources, total, page, pageSize }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [deleteId, setDeleteId] = useState<string | null>(null);
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
          value={searchValue}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead className="w-[80px]">Source</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[140px]">Crawled</TableHead>
            <TableHead className="w-[140px]">Updated</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {resources.map((resource) => (
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
          {resources.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No resources found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Pagination total={total} pageSize={pageSize} page={page} />

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
