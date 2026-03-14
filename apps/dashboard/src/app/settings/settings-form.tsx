"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { setSetting } from "./actions";
import { Save } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Setting } from "@schema";

const MAIN_MODELS = [
  { value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { value: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "openai/gpt-5.2", label: "GPT-5.2" },
  { value: "openai/gpt-5.1-thinking", label: "GPT-5.1 Thinking" },
  { value: "openai/gpt-4o", label: "GPT-4o" },
  { value: "google/gemini-3-pro-preview", label: "Gemini 3 Pro" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "xai/grok-4.1-fast-reasoning", label: "Grok 4.1 Fast" },
  { value: "deepseek/deepseek-v3.2-thinking", label: "DeepSeek V3.2 Thinking" },
];

const FAST_MODELS = [
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { value: "openai/gpt-5.1-instant", label: "GPT-5.1 Instant" },
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "google/gemini-3-flash", label: "Gemini 3 Flash" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "xai/grok-4.1-fast-non-reasoning", label: "Grok 4.1 Fast NR" },
  { value: "xai/grok-code-fast-1", label: "Grok Code Fast 1" },
  { value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
];

const EMBEDDING_MODELS = [
  { value: "openai/text-embedding-3-small", label: "OpenAI Embedding 3 Small (1536d)" },
  { value: "openai/text-embedding-3-large", label: "OpenAI Embedding 3 Large (3072d)" },
  { value: "google/text-embedding-005", label: "Google Embedding 005" },
];

function getSettingValue(settings: Setting[], key: string): string {
  return settings.find((s) => s.key === key)?.value || "";
}

export function SettingsForm({ settings }: { settings: Setting[] }) {
  const router = useRouter();
  const [mainModel, setMainModel] = useState(getSettingValue(settings, "model_main"));
  const [fastModel, setFastModel] = useState(getSettingValue(settings, "model_fast"));
  const [embeddingModel, setEmbeddingModel] = useState(getSettingValue(settings, "model_embedding"));
  const [saving, setSaving] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("");

  const nonModelSettings = settings.filter(
    (s) => !s.key.startsWith("model_") && !s.key.startsWith("credential:"),
  );

  async function handleSaveModels() {
    setSaving(true);
    if (mainModel) await setSetting("model_main", mainModel);
    if (fastModel) await setSetting("model_fast", fastModel);
    if (embeddingModel) await setSetting("model_embedding", embeddingModel);
    setSaving(false);
    router.refresh();
  }

  async function handleSaveSetting() {
    if (!editKey) return;
    await setSetting(editKey, editValue);
    setEditKey("");
    setEditValue("");
    router.refresh();
  }

  return (
    <>
      <Card>
        <CardHeader><CardTitle className="text-base">Model Selection</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Main Model</label>
              <Select value={mainModel || "__default"} onValueChange={(v) => setMainModel(v === "__default" ? "" : v)}>
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
              <Select value={fastModel || "__default"} onValueChange={(v) => setFastModel(v === "__default" ? "" : v)}>
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
              <Select value={embeddingModel || "__default"} onValueChange={(v) => setEmbeddingModel(v === "__default" ? "" : v)}>
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
          <Button onClick={handleSaveModels} disabled={saving} size="sm">
            <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save Models"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">All Settings</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table className="min-w-[550px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Key</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="w-[140px]">Updated</TableHead>
                  <TableHead className="w-[120px]">By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nonModelSettings.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="font-mono text-sm">{s.key}</TableCell>
                    <TableCell className="text-sm">{s.value}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{formatDate(s.updatedAt)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{s.updatedBy || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Edit Setting</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input placeholder="Key" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
            <Input placeholder="Value" value={editValue} onChange={(e) => setEditValue(e.target.value)} />
          </div>
          <Button onClick={handleSaveSetting} size="sm" disabled={!editKey}>
            <Save className="h-4 w-4" /> Save Setting
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
