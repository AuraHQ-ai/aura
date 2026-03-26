import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DetailSkeleton } from "@/components/page-skeleton";
import { cn, formatDate } from "@/lib/utils";
import { useState, useMemo } from "react";
import { ArrowLeft, Trash2, UserPlus, Check, ChevronsUpDown, Shield, ScrollText } from "lucide-react";

interface Grant {
  id: string;
  granteeId: string;
  granteeName: string | null;
  permission: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface AuditEntry {
  id: string;
  action: string;
  accessedBy: string;
  context: string | null;
  timestamp: string;
}

interface WorkspaceUser {
  slackUserId: string;
  displayName: string | null;
}

interface CredentialData {
  id: string;
  name: string;
  type: string;
  scope: string;
  maskedValue: string;
  ownerName: string;
  createdAt: string;
  expiresAt: string | null;
  grants: Grant[];
  auditLog: AuditEntry[];
}

const SCOPE_LABELS: Record<string, string> = {
  member: "Everyone (member+)",
  power_user: "Power User+",
  admin: "Admin+",
  owner: "Owner Only",
};

const VALID_SCOPES = ["member", "power_user", "admin", "owner"] as const;

function CredentialDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["credentials", id],
    queryFn: () => apiGet<CredentialData>(`/credentials/${id}`),
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users-list"],
    queryFn: () => apiGet<{ items: WorkspaceUser[] }>("/users?limit=500").then((d) => d.items),
  });

  const [showUpdateValue, setShowUpdateValue] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [showGrant, setShowGrant] = useState(false);
  const [granteeId, setGranteeId] = useState("");
  const [permission, setPermission] = useState("read");
  const [userPickerOpen, setUserPickerOpen] = useState(false);

  const selectedUser = useMemo(
    () => users.find((u) => u.slackUserId === granteeId),
    [users, granteeId],
  );

  const updateValueMutation = useMutation({
    mutationFn: () => apiPatch(`/credentials/${id}/value`, { value: newValue }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
      setShowUpdateValue(false);
      setNewValue("");
    },
  });

  const scopeMutation = useMutation({
    mutationFn: (scope: string) => apiPatch(`/credentials/${id}/scope`, { scope }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["credentials"] }),
  });

  const grantMutation = useMutation({
    mutationFn: () =>
      apiPost(`/credentials/${id}/grants`, { granteeId, permission, grantedBy: "dashboard" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
      setShowGrant(false);
      setGranteeId("");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (grantId: string) => apiDelete(`/credentials/${id}/grants/${grantId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["credentials"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/credentials/${id}`),
    onSuccess: () => navigate({ to: "/credentials" }),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load credential: {error.message}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/credentials"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold font-mono truncate">{data.name}</h1>
          <p className="text-sm text-muted-foreground">Owned by {data.ownerName}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary">{data.type}</Badge>
          <Button variant="outline" size="sm" onClick={() => setShowUpdateValue(true)}>Update Value</Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => { if (confirm("Delete this credential?")) deleteMutation.mutate(); }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Value</CardTitle></CardHeader>
          <CardContent>
            <code className="text-sm font-mono">{data.maskedValue}</code>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Scope (min role)</CardTitle></CardHeader>
          <CardContent>
            <select
              value={data.scope}
              onChange={(e) => scopeMutation.mutate(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {VALID_SCOPES.map((s) => (
                <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
              ))}
            </select>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Created</CardTitle></CardHeader>
          <CardContent><span className="text-sm">{formatDate(data.createdAt)}</span></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Expires</CardTitle></CardHeader>
          <CardContent><span className="text-sm">{formatDate(data.expiresAt)}</span></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="grants">
        <TabsList>
          <TabsTrigger value="grants"><Shield /> Grants ({data.grants.length})</TabsTrigger>
          <TabsTrigger value="audit"><ScrollText /> Audit Log ({data.auditLog.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="grants">
          <div className="flex justify-end mb-2">
            <Button size="sm" onClick={() => setShowGrant(true)}>
              <UserPlus className="h-4 w-4" /> Add Grant
            </Button>
          </div>
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Grantee</TableHead>
                  <TableHead>Permission</TableHead>
                  <TableHead>Granted By</TableHead>
                  <TableHead>Granted At</TableHead>
                  <TableHead>Revoked</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.grants.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.granteeName || g.granteeId}</TableCell>
                    <TableCell><Badge variant="outline">{g.permission}</Badge></TableCell>
                    <TableCell className="text-sm">{g.grantedBy}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(g.grantedAt)}</TableCell>
                    <TableCell>{g.revokedAt ? formatDate(g.revokedAt) : "—"}</TableCell>
                    <TableCell>
                      {!g.revokedAt && (
                        <Button variant="ghost" size="sm" onClick={() => revokeMutation.mutate(g.id)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {data.grants.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-4">No grants</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="audit">
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Context</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.auditLog.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell><Badge variant="outline">{entry.action}</Badge></TableCell>
                    <TableCell className="text-sm">{entry.accessedBy}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{entry.context || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(entry.timestamp)}</TableCell>
                  </TableRow>
                ))}
                {data.auditLog.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-4">No audit entries</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={showUpdateValue} onOpenChange={setShowUpdateValue}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Credential Value</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input type="password" placeholder="New value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowUpdateValue(false)}>Cancel</Button>
              <Button onClick={() => updateValueMutation.mutate()} disabled={updateValueMutation.isPending}>
                {updateValueMutation.isPending ? "Updating..." : "Update"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showGrant} onOpenChange={setShowGrant}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grant Access</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Popover open={userPickerOpen} onOpenChange={setUserPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={userPickerOpen}
                  className="w-full justify-between font-normal"
                >
                  {selectedUser
                    ? selectedUser.displayName || selectedUser.slackUserId
                    : "Select a user..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search users..." />
                  <CommandList>
                    <CommandEmpty>No users found.</CommandEmpty>
                    <CommandGroup>
                      {users.map((user) => (
                        <CommandItem
                          key={user.slackUserId}
                          value={`${user.displayName ?? ""} ${user.slackUserId}`}
                          onSelect={() => {
                            setGranteeId(user.slackUserId);
                            setUserPickerOpen(false);
                          }}
                        >
                          <Check className={cn("mr-2 h-4 w-4", granteeId === user.slackUserId ? "opacity-100" : "opacity-0")} />
                          <span>{user.displayName || user.slackUserId}</span>
                          <span className="ml-auto text-xs text-muted-foreground">{user.slackUserId}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px]"
            >
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="admin">Admin</option>
            </select>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowGrant(false)}>Cancel</Button>
              <Button onClick={() => grantMutation.mutate()} disabled={grantMutation.isPending}>
                {grantMutation.isPending ? "Granting..." : "Grant"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Route = createFileRoute("/credentials/$id")({
  component: CredentialDetailPage,
});
