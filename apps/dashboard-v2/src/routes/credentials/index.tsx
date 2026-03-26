import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { TableRowsSkeleton } from "@/components/page-skeleton";
import { Pagination } from "@/components/pagination";
import { cn, formatDate } from "@/lib/utils";
import { useState, useMemo } from "react";
import { Plus, Search, Check, ChevronsUpDown } from "lucide-react";

const SCOPE_LABELS: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "outline" | "destructive";
  }
> = {
  member: { label: "Everyone", variant: "secondary" },
  power_user: { label: "Power User+", variant: "outline" },
  admin: { label: "Admin+", variant: "outline" },
  owner: { label: "Owner Only", variant: "destructive" },
  per_user: { label: "Per User", variant: "default" },
};

interface CredentialRow {
  id: string;
  name: string;
  type: string;
  scope: string;
  ownerId: string;
  ownerName: string;
  expiresAt: string | null;
  createdAt: string;
  grantCount: number;
}

interface WorkspaceUser {
  slackUserId: string;
  displayName: string | null;
}

const PAGE_SIZE = 100;

function CredentialsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("token");
  const [newValue, setNewValue] = useState("");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [newScope, setNewScope] = useState("member");
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["credentials", search, page],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiGet<{ items: CredentialRow[]; total: number }>(
        `/credentials?${params}`,
      );
    },
    placeholderData: keepPreviousData,
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users-list-for-credentials"],
    queryFn: () =>
      apiGet<{ items: WorkspaceUser[] }>("/users?limit=500").then(
        (d) => d.items,
      ),
    enabled: showCreate,
  });

  const selectedOwner = useMemo(
    () => users.find((u) => u.slackUserId === newOwnerId),
    [users, newOwnerId],
  );

  const createMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      type: string;
      value: string;
      ownerId: string;
      scope: string;
    }) => apiPost("/credentials", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
      setShowCreate(false);
      setNewName("");
      setNewType("token");
      setNewValue("");
      setNewOwnerId("");
      setNewScope("member");
    },
  });

  if (error && !data)
    return (
      <div className="text-destructive text-sm">
        Failed to load credentials: {error.message}
      </div>
    );

  const credentials = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Credentials</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "…" : `${total} total`}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search credentials..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> Add Credential
        </Button>
      </div>

      <div className={cn("rounded-xl border overflow-x-auto transition-opacity", isFetching && !isLoading && "opacity-50")}>
        <Table className="min-w-[550px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[80px]">Type</TableHead>
              <TableHead className="w-[120px]">Scope</TableHead>
              <TableHead className="w-[160px]">Owner</TableHead>
              <TableHead className="w-[140px]">Expires</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRowsSkeleton columns={5} />
            ) : credentials.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground py-8"
                >
                  No credentials found
                </TableCell>
              </TableRow>
            ) : (
              credentials.map((cred) => (
                <TableRow key={cred.id}>
                  <TableCell>
                    <Link
                      to="/credentials/$id"
                      params={{ id: cred.id }}
                      className="font-medium hover:underline font-mono"
                    >
                      {cred.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{cred.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        SCOPE_LABELS[cred.scope]?.variant ?? "secondary"
                      }
                    >
                      {SCOPE_LABELS[cred.scope]?.label ?? cred.scope}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{cred.ownerName}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(cred.expiresAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={PAGE_SIZE} page={page} onPageChange={setPage} />

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Credential</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Type</label>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
              >
                <option value="token">Token</option>
                <option value="oauth_client">OAuth Client</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Owner</label>
              <Popover
                open={ownerPickerOpen}
                onOpenChange={setOwnerPickerOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={ownerPickerOpen}
                    className="w-full justify-between font-normal"
                  >
                    {selectedOwner
                      ? selectedOwner.displayName ||
                        selectedOwner.slackUserId
                      : "Select owner…"}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[--radix-popover-trigger-width] p-0"
                  align="start"
                >
                  <Command>
                    <CommandInput placeholder="Search users…" />
                    <CommandList>
                      <CommandEmpty>No users found.</CommandEmpty>
                      <CommandGroup>
                        {users.map((user) => (
                          <CommandItem
                            key={user.slackUserId}
                            value={`${user.displayName ?? ""} ${user.slackUserId}`}
                            onSelect={() => {
                              setNewOwnerId(user.slackUserId);
                              setOwnerPickerOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                newOwnerId === user.slackUserId
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                            <span>
                              {user.displayName || user.slackUserId}
                            </span>
                            <span className="ml-auto text-xs text-muted-foreground">
                              {user.slackUserId}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input
                placeholder="e.g. github_token"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and underscores only
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Scope</label>
              <select
                value={newScope}
                onChange={(e) => setNewScope(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
              >
                <option value="member">Everyone (member+)</option>
                <option value="power_user">Power User+</option>
                <option value="admin">Admin+</option>
                <option value="owner">Owner Only</option>
                <option value="per_user">Per User (owner only)</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Minimum role required to access this credential
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Value</label>
              <Input
                type="password"
                placeholder="Secret value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={() =>
                  createMutation.mutate({
                    name: newName,
                    type: newType,
                    value: newValue,
                    ownerId: newOwnerId,
                    scope: newScope,
                  })
                }
                disabled={
                  !newName ||
                  !newValue ||
                  !newOwnerId ||
                  createMutation.isPending
                }
              >
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Route = createFileRoute("/credentials/")({
  component: CredentialsPage,
});
