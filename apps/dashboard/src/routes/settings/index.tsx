import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageSkeleton } from "@/components/page-skeleton";
import { formatDate } from "@/lib/utils";
import { useState } from "react";
import { RefreshCw, Save, Plus, Pencil } from "lucide-react";

interface Setting {
  key: string;
  value: string;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

interface ModelOption {
  value: string;
  label: string;
}

interface ModelCatalog {
  main: ModelOption[];
  fast: ModelOption[];
  embedding: ModelOption[];
  escalation: ModelOption[];
  defaults: { main?: string; fast?: string; embedding?: string; escalation?: string };
  catalog: Array<{
    value: string;
    label: string;
    provider: string;
    type: string;
    enabledCategories: string[];
    defaultCategories: string[];
    lastSyncedAt: string | null;
  }>;
  lastSyncedAt: string | null;
}

function SettingsPage() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading: loadingSettings, error: settingsError } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<Setting[]>("/settings"),
  });

  const { data: models } = useQuery({
    queryKey: ["models"],
    queryFn: () => apiGet<ModelCatalog>("/models"),
  });

  const [mainModel, setMainModel] = useState<string | null>(null);
  const [fastModel, setFastModel] = useState<string | null>(null);
  const [embeddingModel, setEmbeddingModel] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");

  function openCreate() {
    setEditingKey(null);
    setFormKey("");
    setFormValue("");
    setDialogOpen(true);
  }

  function openEdit(setting: Setting) {
    setEditingKey(setting.key);
    setFormKey(setting.key);
    setFormValue(setting.value);
    setDialogOpen(true);
  }

  function getSettingValue(key: string): string {
    return settings?.find((s) => s.key === key)?.value || "";
  }

  const actualMainModel = mainModel ?? getSettingValue("model_main");
  const actualFastModel = fastModel ?? getSettingValue("model_fast");
  const actualEmbeddingModel = embeddingModel ?? getSettingValue("model_embedding");

  const saveModelsMutation = useMutation({
    mutationFn: async () => {
      await apiPut("/settings/model_main", { value: actualMainModel || "" });
      await apiPut("/settings/model_fast", { value: actualFastModel || "" });
      await apiPut("/settings/model_embedding", { value: actualEmbeddingModel || "" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const refreshModelsMutation = useMutation({
    mutationFn: () => apiPost("/models/refresh", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });

  const saveSettingMutation = useMutation({
    mutationFn: () => apiPut(`/settings/${formKey}`, { value: formValue }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setDialogOpen(false);
    },
  });

  if (loadingSettings) return <PageSkeleton rows={8} />;
  if (settingsError) return <div className="text-destructive text-sm">Failed to load settings: {settingsError.message}</div>;

  const nonModelSettings = (settings ?? []).filter(
    (s) => !s.key.startsWith("model_") && !s.key.startsWith("credential:"),
  );

  const MAIN_MODELS = models?.main ?? [];
  const FAST_MODELS = models?.fast ?? [];
  const EMBEDDING_MODELS = models?.embedding ?? [];
  const isEditing = editingKey !== null;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader><CardTitle className="text-base">Model Selection</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {models?.lastSyncedAt
                ? `Catalog refreshed ${formatDate(models.lastSyncedAt)}`
                : "Catalog has not been refreshed yet."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshModelsMutation.mutate()}
              disabled={refreshModelsMutation.isPending}
            >
              <RefreshCw className="h-4 w-4" />
              {refreshModelsMutation.isPending ? "Refreshing..." : "Refresh Catalog"}
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Main Model</label>
              <Select value={actualMainModel || "__default"} onValueChange={(v) => setMainModel(v === "__default" ? "" : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">Default</SelectItem>
                  {MAIN_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Fast Model</label>
              <Select value={actualFastModel || "__default"} onValueChange={(v) => setFastModel(v === "__default" ? "" : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">Default</SelectItem>
                  {FAST_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Embedding Model</label>
              <Select value={actualEmbeddingModel || "__default"} onValueChange={(v) => setEmbeddingModel(v === "__default" ? "" : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">Default</SelectItem>
                  {EMBEDDING_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={() => saveModelsMutation.mutate()} disabled={saveModelsMutation.isPending} size="sm">
            <Save className="h-4 w-4" /> {saveModelsMutation.isPending ? "Saving..." : "Save Models"}
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">All Settings</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Setting
        </Button>
      </div>

      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-[160px]">Updated</TableHead>
              <TableHead className="w-[120px]">By</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {nonModelSettings.map((s) => (
              <TableRow key={s.key}>
                <TableCell className="font-mono text-sm">{s.key}</TableCell>
                <TableCell className="text-sm">{s.value}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(s.updatedAt)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{s.updatedBy || "—"}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(s)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {nonModelSettings.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">No settings</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Setting" : "Add Setting"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Key</label>
              <Input
                placeholder="e.g. my_setting"
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                disabled={isEditing}
              />
              {!isEditing && (
                <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and underscores</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Value</label>
              <Input
                placeholder="Setting value"
                value={formValue}
                onChange={(e) => setFormValue(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() => saveSettingMutation.mutate()}
                disabled={!formKey || saveSettingMutation.isPending}
              >
                {saveSettingMutation.isPending ? "Saving..." : isEditing ? "Save" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
});
