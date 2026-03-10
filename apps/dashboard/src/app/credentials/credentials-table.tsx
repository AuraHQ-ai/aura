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
import { formatDate } from "@/lib/utils";
import { createCredential } from "./actions";
import { Plus, Search } from "lucide-react";

interface CredentialRow {
  id: string;
  name: string;
  type: string;
  ownerId: string;
  ownerName: string;
  expiresAt: Date | null;
  createdAt: Date;
  grantCount: number;
}

interface Props {
  credentials: CredentialRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function CredentialsTable({ credentials, total, page, pageSize }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("token");
  const [newValue, setNewValue] = useState("");
  const [newOwnerId, setNewOwnerId] = useState("");
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
    if (!newName || !newValue || !newOwnerId) return;
    await createCredential({
      name: newName,
      type: newType,
      value: newValue,
      ownerId: newOwnerId,
    });
    setShowCreate(false);
    setNewName("");
    setNewType("token");
    setNewValue("");
    setNewOwnerId("");
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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Grants</TableHead>
            <TableHead>Expires</TableHead>
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
              <TableCell className="text-sm">{cred.ownerName}</TableCell>
              <TableCell>{cred.grantCount}</TableCell>
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

      <Pagination total={total} pageSize={pageSize} page={page} />

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogHeader>
          <DialogTitle>Add Credential</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Name (lowercase, underscores)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px]"
          >
            <option value="token">Token</option>
            <option value="oauth_client">OAuth Client</option>
          </select>
          <Input placeholder="Owner Slack User ID" value={newOwnerId} onChange={(e) => setNewOwnerId(e.target.value)} />
          <Input type="password" placeholder="Value / Secret" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
