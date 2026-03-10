"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";
import { createCredential } from "./actions";
import { Plus, Search } from "lucide-react";

interface CredentialRow {
  id: string;
  name: string;
  type: string;
  ownerId: string;
  ownerName: string;
  sandboxEnvName: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  grantCount: number;
}

export function CredentialsTable({ credentials }: { credentials: CredentialRow[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("token");
  const [newValue, setNewValue] = useState("");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [newSandboxEnv, setNewSandboxEnv] = useState("");

  const filtered = search
    ? credentials.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : credentials;

  async function handleCreate() {
    if (!newName || !newValue || !newOwnerId) return;
    await createCredential({
      name: newName,
      type: newType,
      value: newValue,
      ownerId: newOwnerId,
      sandboxEnvName: newSandboxEnv || undefined,
    });
    setShowCreate(false);
    setNewName("");
    setNewType("token");
    setNewValue("");
    setNewOwnerId("");
    setNewSandboxEnv("");
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search credentials..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> Add Credential
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Sandbox Env</TableHead>
            <TableHead>Grants</TableHead>
            <TableHead>Expires</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((cred) => (
            <TableRow key={cred.id}>
              <TableCell>
                <Link href={`/credentials/${cred.id}`} className="font-medium hover:underline font-mono">
                  {cred.name}
                </Link>
              </TableCell>
              <TableCell><Badge variant="secondary">{cred.type}</Badge></TableCell>
              <TableCell className="text-sm">{cred.ownerName}</TableCell>
              <TableCell className="font-mono text-sm text-muted-foreground">{cred.sandboxEnvName || "—"}</TableCell>
              <TableCell>{cred.grantCount}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(cred.expiresAt)}</TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No credentials found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogHeader>
          <DialogTitle>Add Credential</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Name (lowercase, underscores)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="token">Token</option>
            <option value="oauth_client">OAuth Client</option>
          </select>
          <Input placeholder="Owner Slack User ID" value={newOwnerId} onChange={(e) => setNewOwnerId(e.target.value)} />
          <Input type="password" placeholder="Value / Secret" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <Input placeholder="Sandbox env name (optional, e.g. STRIPE_API_KEY)" value={newSandboxEnv} onChange={(e) => setNewSandboxEnv(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
