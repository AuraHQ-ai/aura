import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";

type McpStatus = "connected" | "needs_auth" | "error";

interface McpTool {
  name: string;
  description: string | null;
  allowed: boolean;
}

interface McpServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: string;
  authType: string;
  headerName: string | null;
  hasHeaderAuth: boolean;
  visibility: string;
  ownerId: string | null;
  enabled: boolean;
  trusted: boolean;
  deniedTools: string[];
  toolCount: number;
  status: McpStatus;
  lastError: string | null;
  canManage: boolean;
  authUrl?: string;
  tools?: McpTool[];
}

interface McpListResponse {
  items: McpServer[];
  total: number;
  viewer: { userId: string | null; isAdmin: boolean };
}

const STATUS_VARIANT: Record<McpStatus, "success" | "warning" | "destructive"> = {
  connected: "success",
  needs_auth: "warning",
  error: "destructive",
};

const STATUS_LABEL: Record<McpStatus, string> = {
  connected: "Connected",
  needs_auth: "Needs auth",
  error: "Error",
};

function McpPage() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [newUrl, setNewUrl] = useState("");
  const [newName, setNewName] = useState("");
  const [newVisibility, setNewVisibility] = useState<"personal" | "workspace">("personal");
  const [newTransport, setNewTransport] = useState<"http" | "sse">("http");
  const [newHeaderName, setNewHeaderName] = useState("");
  const [newHeaderValue, setNewHeaderValue] = useState("");

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => apiGet<McpListResponse>("/mcp"),
  });

  const servers = data?.items ?? [];
  const isAdmin = data?.viewer.isAdmin ?? false;

  const { data: detail } = useQuery({
    queryKey: ["mcp-servers", expandedId],
    queryFn: () => apiGet<McpServer>(`/mcp/${expandedId}`),
    enabled: Boolean(expandedId),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  }

  const addMutation = useMutation({
    mutationFn: (payload: {
      url: string;
      name?: string;
      visibility: "personal" | "workspace";
      transport: "http" | "sse";
      headerName?: string;
      headerValue?: string;
    }) => apiPost<McpServer>("/mcp", payload),
    onSuccess: (created) => {
      invalidate();
      setAddError(null);
      if (created.authUrl) {
        setAuthUrl(created.authUrl);
        return;
      }
      resetAdd();
      setShowAdd(false);
    },
    onError: (err: Error) => {
      setAddError(err.message);
    },
  });

  const enabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiPatch(`/mcp/${id}/enabled`, { enabled }),
    onSuccess: invalidate,
  });

  const trustedMutation = useMutation({
    mutationFn: ({ id, trusted }: { id: string; trusted: boolean }) =>
      apiPatch(`/mcp/${id}/trusted`, { trusted }),
    onSuccess: invalidate,
  });

  const toolMutation = useMutation({
    mutationFn: ({ id, tool, allowed }: { id: string; tool: string; allowed: boolean }) =>
      apiPatch(`/mcp/${id}/tools`, { tool, allowed }),
    onSuccess: invalidate,
  });

  const authMutation = useMutation({
    mutationFn: (id: string) => apiPost<McpServer>(`/mcp/${id}/auth`),
    onSuccess: (result) => {
      invalidate();
      if (result.authUrl) setAuthUrl(result.authUrl);
    },
  });

  const refreshMutation = useMutation({
    mutationFn: (id: string) => apiPost(`/mcp/${id}/refresh`),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/mcp/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteId(null);
      if (expandedId === deleteId) setExpandedId(null);
    },
  });

  function resetAdd() {
    setNewUrl("");
    setNewName("");
    setNewVisibility("personal");
    setNewTransport("http");
    setNewHeaderName("");
    setNewHeaderValue("");
    setAddError(null);
    setAuthUrl(null);
  }

  if (error && !data) {
    return (
      <div className="text-destructive text-sm">
        Failed to load MCP servers: {error.message}
      </div>
    );
  }

  const expandedTools = detail?.id === expandedId ? (detail.tools ?? []) : [];

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">MCP Servers</h1>
          <p className="text-sm text-muted-foreground">
            Connect third-party tools. Tokens are stored encrypted and never shown here.
          </p>
        </div>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${data?.total ?? 0} total`}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            resetAdd();
            setShowAdd(true);
          }}
        >
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>

      <div
        className={cn(
          "flex-1 min-h-0 rounded-xl border overflow-auto transition-opacity",
          isFetching && !isLoading && "opacity-50",
        )}
      >
        <Table className="min-w-[960px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[28px]" />
              <TableHead>Name</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[80px]">Tools</TableHead>
              <TableHead className="w-[110px]">Visibility</TableHead>
              <TableHead className="w-[90px]">Enabled</TableHead>
              {isAdmin && <TableHead className="w-[90px]">Trusted</TableHead>}
              <TableHead className="w-[220px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={isAdmin ? 8 : 7} rows={8} />
            ) : servers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={isAdmin ? 8 : 7}
                  className="text-center text-muted-foreground py-8"
                >
                  No MCP servers yet. Add one by URL.
                </TableCell>
              </TableRow>
            ) : (
              servers.flatMap((server) => {
                const open = expandedId === server.id;
                const rows = [
                  <TableRow key={server.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-muted-foreground"
                        onClick={() => setExpandedId(open ? null : server.id)}
                        aria-label={open ? "Collapse tools" : "Expand tools"}
                      >
                        {open ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{server.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {server.slug} · {server.url}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[server.status]}>
                        {STATUS_LABEL[server.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>{server.toolCount}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{server.visibility}</Badge>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={server.enabled}
                        onCheckedChange={(enabled) =>
                          enabledMutation.mutate({ id: server.id, enabled })
                        }
                        disabled={!server.canManage || enabledMutation.isPending}
                      />
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        <Switch
                          checked={server.trusted}
                          onCheckedChange={(trusted) =>
                            trustedMutation.mutate({ id: server.id, trusted })
                          }
                          disabled={trustedMutation.isPending}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => authMutation.mutate(server.id)}
                          disabled={authMutation.isPending}
                        >
                          Re-auth
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => refreshMutation.mutate(server.id)}
                          disabled={!server.canManage || refreshMutation.isPending}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDeleteId(server.id)}
                          disabled={!server.canManage}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>,
                ];
                if (open) {
                  rows.push(
                    <TableRow key={`${server.id}-tools`}>
                      <TableCell colSpan={isAdmin ? 8 : 7} className="bg-muted/30">
                        <div className="space-y-2 py-2">
                          <div className="text-sm font-medium">Tools</div>
                          {server.lastError && (
                            <p className="text-sm text-destructive">{server.lastError}</p>
                          )}
                          {expandedTools.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              {detail?.id === server.id
                                ? "No tools cached yet. Refresh after connecting."
                                : "Loading tools…"}
                            </p>
                          ) : (
                            <div className="space-y-1.5">
                              {expandedTools.map((tool) => (
                                <div
                                  key={tool.name}
                                  className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
                                >
                                  <div className="min-w-0">
                                    <div className="font-mono text-sm">{tool.name}</div>
                                    {tool.description && (
                                      <div className="text-xs text-muted-foreground truncate">
                                        {tool.description}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="text-xs text-muted-foreground">
                                      {tool.allowed ? "Allowed" : "Denied"}
                                    </span>
                                    <Switch
                                      checked={tool.allowed}
                                      onCheckedChange={(allowed) =>
                                        toolMutation.mutate({
                                          id: server.id,
                                          tool: tool.name,
                                          allowed,
                                        })
                                      }
                                      disabled={!server.canManage || toolMutation.isPending}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>,
                  );
                }
                return rows;
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={showAdd}
        onOpenChange={(open) => {
          setShowAdd(open);
          if (!open) resetAdd();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add MCP server</DialogTitle>
          </DialogHeader>
          <Tabs defaultValue="url">
            <TabsList>
              <TabsTrigger value="url">Manual URL</TabsTrigger>
              <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
            </TabsList>
            <TabsContent value="url" className="space-y-4 pt-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Server URL</label>
                <Input
                  placeholder="https://mcp.stripe.com/mcp"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Name</label>
                <Input
                  placeholder="Stripe (optional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Visibility</label>
                  <select
                    value={newVisibility}
                    onChange={(e) =>
                      setNewVisibility(e.target.value as "personal" | "workspace")
                    }
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
                  >
                    <option value="personal">Personal</option>
                    {isAdmin && <option value="workspace">Workspace</option>}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Transport</label>
                  <select
                    value={newTransport}
                    onChange={(e) => setNewTransport(e.target.value as "http" | "sse")}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
                  >
                    <option value="http">HTTP</option>
                    <option value="sse">SSE</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Header auth (optional)</label>
                <Input
                  placeholder="Header name, e.g. Authorization"
                  value={newHeaderName}
                  onChange={(e) => setNewHeaderName(e.target.value)}
                />
                <Input
                  type="password"
                  placeholder="Header value (never shown again)"
                  value={newHeaderValue}
                  onChange={(e) => setNewHeaderValue(e.target.value)}
                />
              </div>
              {addError && <p className="text-sm text-destructive">{addError}</p>}
              {authUrl && (
                <p className="text-sm">
                  Authorization required.{" "}
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Open auth URL
                  </a>
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setShowAdd(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    addMutation.mutate({
                      url: newUrl,
                      name: newName.trim() || undefined,
                      visibility: newVisibility,
                      transport: newTransport,
                      headerName: newHeaderName.trim() || undefined,
                      headerValue: newHeaderValue || undefined,
                    })
                  }
                  disabled={!newUrl || addMutation.isPending}
                >
                  {addMutation.isPending ? "Adding…" : "Add server"}
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="marketplace" className="pt-6">
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                Marketplace catalog is coming soon.
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(authUrl) && !showAdd} onOpenChange={(open) => !open && setAuthUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Authorize MCP server</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Open the authorization URL, then return here. Aura will mark the server connected after the callback.
          </p>
          {authUrl && (
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline break-all"
            >
              {authUrl}
            </a>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteId)} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove MCP server</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This deletes the server and any stored connections. Encrypted tokens are removed with it.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Removing…" : "Remove"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Route = createFileRoute("/mcp/")({
  component: McpPage,
});
