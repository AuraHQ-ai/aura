"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  updateCredentialValue,
  grantCredentialAccess,
  revokeCredentialAccess,
  deleteCredential,
} from "../actions";
import { ArrowLeft, Trash2, UserPlus } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Credential, CredentialGrant, CredentialAuditEntry } from "@schema";

interface CredentialData extends Credential {
  maskedValue: string;
  ownerName: string;
  grants: CredentialGrant[];
  granteeNames: Record<string, string>;
  auditLog: CredentialAuditEntry[];
}

export function CredentialDetail({ data }: { data: CredentialData }) {
  const router = useRouter();
  const [showUpdateValue, setShowUpdateValue] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [showGrant, setShowGrant] = useState(false);
  const [granteeId, setGranteeId] = useState("");
  const [permission, setPermission] = useState("read");

  async function handleUpdateValue() {
    if (!newValue) return;
    await updateCredentialValue(data.id, newValue);
    setShowUpdateValue(false);
    setNewValue("");
    router.refresh();
  }

  async function handleGrant() {
    if (!granteeId) return;
    await grantCredentialAccess(data.id, granteeId, permission, "dashboard");
    setShowGrant(false);
    setGranteeId("");
    router.refresh();
  }

  async function handleRevoke(grantId: string) {
    await revokeCredentialAccess(grantId, data.id);
    router.refresh();
  }

  async function handleDelete() {
    if (!confirm("Delete this credential?")) return;
    await deleteCredential(data.id);
    router.push("/credentials");
  }

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/credentials">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold font-mono truncate">{data.name}</h1>
          <p className="text-sm text-muted-foreground">Owned by {data.ownerName}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary">{data.type}</Badge>
          <Button variant="outline" size="sm" onClick={() => setShowUpdateValue(true)}>Update Value</Button>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-sm">Value</CardTitle></CardHeader>
          <CardContent>
            <code className="text-sm font-mono">{data.maskedValue}</code>
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
          <TabsTrigger value="grants">Grants ({data.grants.length})</TabsTrigger>
          <TabsTrigger value="audit">Audit Log ({data.auditLog.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="grants">
          <div className="flex justify-end mb-2">
            <Button size="sm" onClick={() => setShowGrant(true)}>
              <UserPlus className="h-4 w-4" /> Add Grant
            </Button>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[600px]">
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
                    <TableCell className="font-medium">{data.granteeNames[g.granteeId] || g.granteeId}</TableCell>
                    <TableCell><Badge variant="outline">{g.permission}</Badge></TableCell>
                    <TableCell className="text-sm">{g.grantedBy}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(g.grantedAt)}</TableCell>
                    <TableCell>{g.revokedAt ? formatDate(g.revokedAt) : "—"}</TableCell>
                    <TableCell>
                      {!g.revokedAt && (
                        <Button variant="ghost" size="sm" onClick={() => handleRevoke(g.id)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {data.grants.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-4">
                      No grants
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="audit">
          <div className="overflow-x-auto">
            <Table className="min-w-[500px]">
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
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                      No audit entries
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={showUpdateValue} onOpenChange={setShowUpdateValue}>
        <DialogHeader>
          <DialogTitle>Update Credential Value</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input type="password" placeholder="New value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowUpdateValue(false)}>Cancel</Button>
            <Button onClick={handleUpdateValue}>Update</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={showGrant} onOpenChange={setShowGrant}>
        <DialogHeader>
          <DialogTitle>Grant Access</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Grantee Slack User ID" value={granteeId} onChange={(e) => setGranteeId(e.target.value)} />
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
            <Button onClick={handleGrant}>Grant</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
