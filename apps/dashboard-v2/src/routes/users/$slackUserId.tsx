import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DetailSkeleton } from "@/components/page-skeleton";
import { formatDate, truncate } from "@/lib/utils";
import { useState } from "react";
import { ArrowLeft, Save, UserRound, Brain } from "lucide-react";

interface UserProfile {
  slackUserId: string;
  displayName: string;
  role: string;
  timezone: string | null;
  interactionCount: number;
  lastInteractionAt: string | null;
  communicationStyle: {
    verbosity: string;
    formality: string;
    emojiUsage: string;
    preferredFormat: string;
  } | null;
}

interface Person {
  id: string;
  jobTitle: string | null;
  preferredLanguage: string | null;
  gender: string | null;
  notes: string | null;
}

interface Memory {
  id: string;
  content: string;
  type: string;
  createdAt: string;
}

interface UserData {
  profile: UserProfile;
  person: Person | null;
  memories: Memory[];
}

const roleOptions = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "power_user", label: "Power User" },
  { value: "member", label: "Member" },
] as const;

function UserDetailPage() {
  const { slackUserId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["users", slackUserId],
    queryFn: () => apiGet<UserData>(`/users/${slackUserId}`),
  });

  const [role, setRole] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState("");
  const [gender, setGender] = useState("");
  const [notes, setNotes] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  if (data && !initialized) {
    setRole(data.profile.role || "member");
    setJobTitle(data.person?.jobTitle || "");
    setPreferredLanguage(data.person?.preferredLanguage || "");
    setGender(data.person?.gender || "");
    setNotes(data.person?.notes || "");
    setInitialized(true);
  }

  const roleMutation = useMutation({
    mutationFn: (newRole: string) => apiPatch(`/users/${slackUserId}/role`, { role: newRole }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setErrMsg(null);
    },
    onError: (e) => setErrMsg(e.message),
  });

  const personMutation = useMutation({
    mutationFn: (personData: { jobTitle?: string; preferredLanguage?: string; gender?: string; notes?: string }) =>
      apiPatch(`/users/person/${data?.person?.id}`, personData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setErrMsg(null);
    },
    onError: (e) => setErrMsg(e.message),
  });

  if (isLoading) return <DetailSkeleton />;
  if (error) return <div className="text-destructive text-sm">Failed to load user: {error.message}</div>;
  if (!data) return null;

  const { profile, person, memories } = data;
  const commStyle = profile.communicationStyle;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/users"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-base font-semibold">{profile.displayName}</h1>
          <p className="text-sm text-muted-foreground font-mono">{profile.slackUserId}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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

      {errMsg && (
        <Card className="border-destructive bg-destructive/10">
          <CardContent className="py-3">
            <p className="text-sm text-destructive">{errMsg}</p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile"><UserRound /> Profile</TabsTrigger>
          <TabsTrigger value="memories"><Brain /> Memories ({memories.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Card className="mb-3">
            <CardContent className="pt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Role</label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button
                onClick={() => roleMutation.mutate(role)}
                disabled={roleMutation.isPending}
                size="sm"
              >
                <Save className="h-4 w-4" /> {roleMutation.isPending ? "Saving..." : "Save Role"}
              </Button>
            </CardContent>
          </Card>

          {person ? (
            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
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
                <Button
                  onClick={() => personMutation.mutate({ jobTitle, preferredLanguage, gender, notes })}
                  disabled={personMutation.isPending}
                  size="sm"
                >
                  <Save className="h-4 w-4" /> {personMutation.isPending ? "Saving..." : "Save"}
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
              <Link key={m.id} to="/memories/$id" params={{ id: m.id }} className="block">
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardContent className="py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="secondary" className="shrink-0">{m.type}</Badge>
                      <span className="text-sm truncate">{truncate(m.content, 80)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">{formatDate(m.createdAt)}</span>
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
    </div>
  );
}

export const Route = createFileRoute("/users/$slackUserId")({
  component: UserDetailPage,
});
