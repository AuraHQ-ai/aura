"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Pagination } from "@/components/pagination";
import { cn, formatDate } from "@/lib/utils";
import { createCredential } from "./actions";
import { Plus, Search, Check, ChevronsUpDown } from "lucide-react";

const SCOPE_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
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
  expiresAt: Date | null;
  createdAt: Date;
  grantCount: number;
}

interface WorkspaceUser {
  slackUserId: string;
  displayName: string | null;
}

interface Props {
  credentials: CredentialRow[];
  total: number;
  page: number;
  pageSize: number;
  users: WorkspaceUser[];
  currentUserId: string;
}

export function CredentialsTable({ credentials, total, page, pageSize, users, currentUserId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("token");
  const [newValue, setNewValue] = useState("");
  const [newOwnerId, setNewOwnerId] = useState(currentUserId);
  const [newScope, setNewScope] = useState("member");
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");

  const selectedOwner = useMemo(
    () => users.find((u) => u.slackUserId === newOwnerId),
    [users, newOwnerId],
  );

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
    if (!newName || !newValue || !newOwnerId) return;
    await createCredential({
      name: newName,
      type: newType,
      value: newValue,
      ownerId: newOwnerId,
      scope: newScope,
    });
    setShowCreate(false);
    setNewName("");
    setNewType("token");
    setNewValue("");
    setNewOwnerId(currentUserId);
    setNewScope("member");
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search credentials..."
            value={searchValue}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> Add Credential
        </Button>
      </div>

      <div className="overflow-x-auto">
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
            {credentials.map((cred) => (
              <TableRow key={cred.id}>
                <TableCell>
                  <Link href={`/credentials/${cred.id}`} className="font-medium hover:underline font-mono">
                    {cred.name}
                  </Link>
                </TableCell>
                <TableCell><Badge variant="secondary">{cred.type}</Badge></TableCell>
                <TableCell>
                  <Badge variant={SCOPE_LABELS[cred.scope]?.variant ?? "secondary"}>
                    {SCOPE_LABELS[cred.scope]?.label ?? cred.scope}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">{cred.ownerName}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(cred.expiresAt)}</TableCell>
              </TableRow>
            ))}
            {credentials.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No credentials found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination total={total} pageSize={pageSize} page={page} />

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
              <Popover open={ownerPickerOpen} onOpenChange={setOwnerPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={ownerPickerOpen}
                    className="w-full justify-between font-normal"
                  >
                    {selectedOwner
                      ? selectedOwner.displayName || selectedOwner.slackUserId
                      : "Select owner…"}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
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
                                newOwnerId === user.slackUserId ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <span>{user.displayName || user.slackUserId}</span>
                            <span className="ml-auto text-xs text-muted-foreground">{user.slackUserId}</span>
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
              <Input placeholder="e.g. github_token" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and underscores only</p>
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
              <p className="text-xs text-muted-foreground">Minimum role required to access this credential</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Value</label>
              <Input type="password" placeholder="Secret value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={handleCreate}>Create</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
