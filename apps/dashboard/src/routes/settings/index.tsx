import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelAutocomplete, type ModelAutocompleteOption } from "@/components/model-autocomplete";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageSkeleton } from "@/components/page-skeleton";
import { ThemeSelect } from "@/components/theme-toggle";
import { formatDate } from "@/lib/utils";
import { MODEL_CATEGORIES, type ModelCategory } from "@/lib/model-categories";
import { useMemo, useState } from "react";
import { RefreshCw, Save, Plus, Pencil, ChevronDown, ChevronRight, Lock } from "lucide-react";

interface Setting {
  key: string;
  value: string;
  hasValue: boolean;
  redacted: boolean;
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
  medium: ModelOption[];
  embedding: ModelOption[];
  escalation: ModelOption[];
  defaults: { main?: string; fast?: string; medium?: string; embedding?: string; escalation?: string };
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

/** Runtime-state keys that represent per-sandbox/per-user transient state. */
function isRuntimeKey(key: string): boolean {
  return (
    key.startsWith("e2b_sandbox_id:") ||
    key.startsWith("e2b_template:") ||
    key.startsWith("sandbox:") ||
    key.startsWith("session:") ||
    key.startsWith("runtime:")
  );
}

const MASKED_VALUE = "••••••••";

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

  const [modelDrafts, setModelDrafts] = useState<Partial<Record<ModelCategory, string>>>({});

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingRedacted, setEditingRedacted] = useState(false);
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);

  function openCreate() {
    setEditingKey(null);
    setEditingRedacted(false);
    setFormKey("");
    setFormValue("");
    setDialogOpen(true);
  }

  function openEdit(setting: Setting) {
    setEditingKey(setting.key);
    setEditingRedacted(setting.redacted);
    setFormKey(setting.key);
    // For redacted settings, start with empty so user must type a new value
    // (empty = no-op on the server side).
    setFormValue(setting.redacted ? "" : setting.value);
    setDialogOpen(true);
  }

  function getSettingValue(key: string): string {
    return settings?.find((s) => s.key === key)?.value || "";
  }

  function actualModel(category: ModelCategory): string {
    return modelDrafts[category] ?? getSettingValue(`model_${category}`);
  }

  const saveModelsMutation = useMutation({
    mutationFn: async () => {
      for (const { value: category } of MODEL_CATEGORIES) {
        await apiPut(`/settings/model_${category}`, { value: actualModel(category) || "" });
      }
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

  const providerByModelId = useMemo(
    () => new Map((models?.catalog ?? []).map((model) => [model.value, model.provider])),
    [models?.catalog],
  );
  const enrichOptions = useMemo(
    () => (options: ModelOption[]): ModelAutocompleteOption[] =>
      options.map((option) => ({
        ...option,
        provider: providerByModelId.get(option.value),
      })),
    [providerByModelId],
  );

  if (loadingSettings) return <PageSkeleton rows={8} />;
  if (settingsError) return <div className="text-destructive text-sm">Failed to load settings: {settingsError.message}</div>;

  const allSettings = settings ?? [];

  // Partition into model, runtime, and regular settings
  const nonModelSettings = allSettings.filter(
    (s) => !s.key.startsWith("model_") && !s.key.startsWith("credential:"),
  );
  const regularSettings = nonModelSettings.filter((s) => !isRuntimeKey(s.key));
  const runtimeSettings = nonModelSettings.filter((s) => isRuntimeKey(s.key));

  const isEditing = editingKey !== null;
  const defaultOption = [{ value: "__default", label: "Default" }];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-xs space-y-1.5">
            <label className="text-sm font-medium">Theme</label>
            <ThemeSelect />
            <p className="text-sm text-muted-foreground">
              Choose light, dark, or follow your system setting.
            </p>
          </div>
        </CardContent>
      </Card>

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
            {MODEL_CATEGORIES.map((category) => (
              <div key={category.value}>
                <label className="text-sm font-medium mb-1 block">{category.title} Model</label>
                <ModelAutocomplete
                  value={actualModel(category.value) || "__default"}
                  onValueChange={(v) =>
                    setModelDrafts((drafts) => ({
                      ...drafts,
                      [category.value]: v === "__default" ? "" : v,
                    }))
                  }
                  options={enrichOptions(models?.[category.value] ?? [])}
                  pinnedOptions={defaultOption}
                  placeholder={`Select ${category.value} model`}
                />
                <p className="text-xs text-muted-foreground mt-1">{category.description}</p>
              </div>
            ))}
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
            {regularSettings.map((s) => (
              <TableRow key={s.key}>
                <TableCell className="font-mono text-sm">
                  <span className="flex items-center gap-1.5">
                    {s.redacted && <Lock className="h-3 w-3 text-muted-foreground shrink-0" />}
                    {s.key}
                  </span>
                </TableCell>
                <TableCell className="text-sm">
                  {s.redacted ? (
                    <span className="text-muted-foreground font-mono">{s.hasValue ? MASKED_VALUE : "—"}</span>
                  ) : (
                    s.value
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(s.updatedAt)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{s.updatedBy || "—"}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(s)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {regularSettings.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">No settings</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {runtimeSettings.length > 0 && (
        <div className="rounded-xl border overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setRuntimeExpanded((v) => !v)}
          >
            {runtimeExpanded ? (
              <ChevronDown className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0" />
            )}
            Runtime state ({runtimeSettings.length})
          </button>
          {runtimeExpanded && (
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
                {runtimeSettings.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="font-mono text-sm">{s.key}</TableCell>
                    <TableCell className="text-sm text-muted-foreground font-mono truncate max-w-xs">{s.value}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{formatDate(s.updatedAt)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{s.updatedBy || "—"}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(s)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}

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
                placeholder={editingRedacted ? "Enter new value to overwrite (leave blank to keep current)" : "Setting value"}
                value={formValue}
                onChange={(e) => setFormValue(e.target.value)}
                type={editingRedacted ? "password" : "text"}
              />
              {editingRedacted && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Lock className="h-3 w-3" />
                  This is a secret field. Leave blank to keep the stored value unchanged.
                </p>
              )}
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
