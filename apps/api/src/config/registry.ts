export type SpecialKey = {
  key: string;
  kind: "setting" | "env";
  scope: "workspace" | "global";
  effect: string;
  example?: string;
  default?: string | null;
  docs_anchor?: string;
};

export const TOOLS_REPO_SETTING = {
  key: "tools_repo",
  kind: "setting",
  scope: "workspace",
  effect:
    "Clones github.com/<value> to /home/user/aura-tools on every sandbox acquisition. Tools registered there become callable from recurring jobs via `python3 /home/user/aura-tools/runner.py <tool_name> <args>`.",
  example: "realadvisor/aura-tools",
  default: null,
  docs_anchor: "tools_repo",
} satisfies SpecialKey;

export const DEFAULT_GITHUB_REPO_SETTING = {
  key: "default_github_repo",
  kind: "setting",
  scope: "workspace",
  effect:
    "Sets the default GitHub repository used when dispatching Cursor Cloud Agents without an explicit repository.",
  example: "AuraHQ-ai/aura",
  default: "AuraHQ-ai/aura",
  docs_anchor: "default_github_repo",
} satisfies SpecialKey;

export const MONGODB_ATLAS_URI_ENV = {
  key: "MONGODB_ATLAS_URI",
  kind: "env",
  scope: "global",
  effect:
    "Advertises MongoDB Atlas as a sandbox scratch/staging storage layer in the agent prompt when the env var is available to the sandbox.",
  example: "mongodb+srv://user:password@cluster.example.mongodb.net/aura",
  default: null,
  docs_anchor: "mongodb_atlas_uri",
} satisfies SpecialKey;

export const GOOGLE_SA_KEY_B64_ENV = {
  key: "GOOGLE_SA_KEY_B64",
  kind: "env",
  scope: "global",
  effect:
    "Mounts the GCS bucket gs://aura-files at /mnt/aura-files inside the sandbox via gcsfuse when present.",
  example: "base64-encoded-service-account-json",
  default: null,
  docs_anchor: "google_sa_key_b64",
} satisfies SpecialKey;

export const E2B_TEMPLATE_ID_ENV = {
  key: "E2B_TEMPLATE_ID",
  kind: "env",
  scope: "global",
  effect:
    "Selects the E2B sandbox template. Changing it forces the next sandbox acquisition to discard a saved sandbox using an older template.",
  example: "tmpl_abc123",
  default: null,
  docs_anchor: "e2b_template_id",
} satisfies SpecialKey;

export const SPECIAL_KEYS = [
  TOOLS_REPO_SETTING,
  DEFAULT_GITHUB_REPO_SETTING,
  MONGODB_ATLAS_URI_ENV,
  GOOGLE_SA_KEY_B64_ENV,
  E2B_TEMPLATE_ID_ENV,
] as const satisfies readonly SpecialKey[];

export function getWorkspaceSpecialSettings(): SpecialKey[] {
  return SPECIAL_KEYS.filter(
    (entry) => entry.kind === "setting" && entry.scope === "workspace",
  );
}
