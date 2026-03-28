import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import { RouteTabs } from "@/components/route-tabs";
import { cn, formatDate, truncate } from "@/lib/utils";
import { useEffect, useState } from "react";
import { Search, Brain, Network } from "lucide-react";

interface Entity {
  id: string;
  type: string;
  canonicalName: string;
  description: string | null;
  slackUserId: string | null;
  memoryCount: number;
  aliasCount: number;
  createdAt: string;
  updatedAt: string;
}

const PAGE_SIZE = 100;
const ENTITY_TYPES = ["person", "company", "project", "product", "channel", "technology"] as const;

type EntitiesSearch = { search?: string; type?: string; page?: number };

function EntitiesPage() {
  const navigate = useNavigate({ from: Route.fullPath });
  const { search, type, page } = Route.useSearch();
  const [searchInput, setSearchInput] = useState(search ?? "");

  useEffect(() => {
    setSearchInput(search ?? "");
  }, [search]);

  const setParams = (updates: Partial<EntitiesSearch>) => {
    navigate({ search: (prev) => ({ ...prev, ...updates }) });
  };

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["entities", search, type, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (type) params.set("type", type);
      params.set("page", String(page ?? 1));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: Entity[]; total: number }>(`/entities?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  if (error && !data) return <div className="text-destructive text-sm">Failed to load entities: {error.message}</div>;

  const entities = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Memories</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <RouteTabs
          tabs={[
            { to: "/memories", label: "Memories", icon: <Brain /> },
            { to: "/memories/entities", label: "Entities", icon: <Network /> },
          ]}
        />
        <form onSubmit={(e) => { e.preventDefault(); setParams({ search: searchInput || undefined, page: undefined }); }} className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search entities..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </form>
        <select
          value={type ?? ""}
          onChange={(e) => setParams({ type: e.target.value || undefined, page: undefined })}
          className="h-8 rounded-md border border-input bg-transparent px-2.5 text-[13px]"
        >
          <option value="">All types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      <div className={cn("flex-1 min-h-0 rounded-xl border overflow-auto transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <Table className="min-w-[700px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[90px]">Type</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-[90px]">Memories</TableHead>
              <TableHead className="w-[80px]">Aliases</TableHead>
              <TableHead className="w-[160px]">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={6} />
            ) : entities.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No entities found</TableCell>
              </TableRow>
            ) : (
              entities.map((entity) => (
                <TableRow key={entity.id}>
                  <TableCell className="font-medium">
                    <Link to="/memories/entities/$id" params={{ id: entity.id }} className="hover:underline">
                      {entity.canonicalName}
                    </Link>
                    {entity.slackUserId && (
                      <span className="ml-1.5 text-xs text-muted-foreground font-mono">{entity.slackUserId}</span>
                    )}
                  </TableCell>
                  <TableCell><Badge variant="secondary">{entity.type}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {entity.description ? truncate(entity.description, 60) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{entity.memoryCount}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{entity.aliasCount}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{formatDate(entity.updatedAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={PAGE_SIZE} page={page ?? 1} onPageChange={(p) => setParams({ page: p > 1 ? p : undefined })} />
    </div>
  );
}

export const Route = createFileRoute("/memories/entities")({
  component: EntitiesPage,
  validateSearch: (raw: Record<string, unknown>) => ({
    search: typeof raw.search === "string" ? raw.search : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    page: typeof raw.page === "number" ? raw.page : typeof raw.page === "string" ? Number(raw.page) || undefined : undefined,
  }),
});
