"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { updatePerson } from "../actions";
import { ArrowLeft, Save } from "lucide-react";
import { formatDate, truncate } from "@/lib/utils";
import type { UserProfile, Person, Memory } from "@schema";

interface UserData {
  profile: UserProfile;
  person: Person | null;
  memories: Omit<Memory, "searchVector">[];
}

export function UserDetail({ data }: { data: UserData }) {
  const router = useRouter();
  const { profile, person, memories } = data;
  const [jobTitle, setJobTitle] = useState(person?.jobTitle || "");
  const [preferredLanguage, setPreferredLanguage] = useState(person?.preferredLanguage || "");
  const [gender, setGender] = useState(person?.gender || "");
  const [notes, setNotes] = useState(person?.notes || "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!person?.id) return;
    setSaving(true);
    await updatePerson(person.id, { jobTitle, preferredLanguage, gender, notes });
    setSaving(false);
    router.refresh();
  }

  const commStyle = profile.communicationStyle;

  return (
    <>
      <div className="flex items-center gap-3">
        <Link href="/users">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-base font-semibold">{profile.displayName}</h1>
          <p className="text-sm text-muted-foreground font-mono">{profile.slackUserId}</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Interactions</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{profile.interactionCount}</div>
            <p className="text-xs text-muted-foreground">Last: {formatDate(profile.lastInteractionAt)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Timezone</CardTitle></CardHeader>
          <CardContent>
            <div className="text-lg font-medium">{profile.timezone || "Unknown"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Communication Style</CardTitle></CardHeader>
          <CardContent>
            {commStyle ? (
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline">{commStyle.verbosity}</Badge>
                <Badge variant="outline">{commStyle.formality}</Badge>
                <Badge variant="outline">{commStyle.emojiUsage} emoji</Badge>
                <Badge variant="outline">{commStyle.preferredFormat}</Badge>
              </div>
            ) : <span className="text-sm text-muted-foreground">Not set</span>}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="memories">Memories ({memories.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          {person ? (
            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Job Title</label>
                    <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Preferred Language</label>
                    <Input value={preferredLanguage} onChange={(e) => setPreferredLanguage(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Gender</label>
                    <Input value={gender} onChange={(e) => setGender(e.target.value)} />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">Notes</label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <Button onClick={handleSave} disabled={saving} size="sm">
                  <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save"}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground py-4">No linked person record.</p>
          )}
        </TabsContent>

        <TabsContent value="memories">
          <div className="space-y-2">
            {memories.map((m) => (
              <Link key={m.id} href={`/memories/${m.id}`} className="block">
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardContent className="py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{m.type}</Badge>
                      <span className="text-sm">{truncate(m.content, 80)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatDate(m.createdAt)}</span>
                  </CardContent>
                </Card>
              </Link>
            ))}
            {memories.length === 0 && (
              <p className="text-sm text-muted-foreground py-4">No memories found for this user.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
