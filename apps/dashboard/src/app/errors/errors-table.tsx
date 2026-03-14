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
import { resolveErrors } from "./actions";
import { Search, CheckCircle } from "lucide-react";
import type { ErrorEvent } from "@schema";

interface Props {
  errors: ErrorEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export function ErrorsTable({ errors, total, page, pageSize }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function handleBulkResolve() {
    await resolveErrors(Array.from(selected));
    setSelected(new Set());
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search errors..."
            value={searchValue}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {selected.size > 0 && (
          <Button size="sm" onClick={handleBulkResolve}>
            <CheckCircle className="h-4 w-4" /> Resolve ({selected.size})
          </Button>
        )}
      </div>

      <div className="overflow-x-auto">
        <Table className="min-w-[700px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead className="w-[180px]">Error</TableHead>
              <TableHead className="w-[80px]">Code</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-[80px]">Status</TableHead>
              <TableHead className="w-[140px]">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {errors.map((err) => (
              <TableRow key={err.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={selected.has(err.id)}
                    onChange={() => toggleSelect(err.id)}
                  />
                </TableCell>
                <TableCell>
                  <Link href={`/errors/${err.id}`} className="font-medium hover:underline">
                    {err.errorName}
                  </Link>
                </TableCell>
                <TableCell>
                  {err.errorCode ? <Badge variant="outline">{err.errorCode}</Badge> : "—"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {truncate(err.errorMessage, 80)}
                </TableCell>
                <TableCell>
                  <Badge variant={err.resolved ? "success" : "destructive"}>
                    {err.resolved ? "Resolved" : "Open"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(err.timestamp)}</TableCell>
              </TableRow>
            ))}
            {errors.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No errors found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={pageSize} page={page} />
    </>
  );
}
