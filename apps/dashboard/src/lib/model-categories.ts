/**
 * Display metadata for model catalog categories — single source of truth for
 * every page that renders categories (job detail, settings). Ordered by
 * ascending capability/cost: fast → medium → main → escalation (embedding
 * last, it's not a text-generation tier).
 *
 * Wording matches the `create_job` tool description in
 * `apps/api/src/tools/jobs.ts` and the model catalog docs.
 */

export type ModelCategory = "fast" | "medium" | "main" | "escalation" | "embedding";

/** Categories a job can be routed to (embedding excluded). */
export type JobModelCategory = Exclude<ModelCategory, "embedding">;

export interface ModelCategoryMeta {
  value: ModelCategory;
  /** Capitalized display name, e.g. "Fast" (settings page labels). */
  title: string;
  description: string;
}

export const MODEL_CATEGORIES: ModelCategoryMeta[] = [
  {
    value: "fast",
    title: "Fast",
    description: "Cheap, mechanical tasks — classification, moderation, digests.",
  },
  {
    value: "medium",
    title: "Medium",
    description: "Sonnet-class intelligence — the standard tier for jobs.",
  },
  {
    value: "main",
    title: "Main",
    description: "Frontier — only for work that genuinely needs it.",
  },
  {
    value: "escalation",
    title: "Escalation",
    description: "Exceptionally hard work.",
  },
  {
    value: "embedding",
    title: "Embedding",
    description: "Vector embeddings for memory retrieval — not usable by jobs.",
  },
];

export interface JobModelSelectOption {
  /** Select value: a job-eligible category, or "__default" for the null override. */
  value: JobModelCategory | "__default";
  label: string;
  description: string;
}

/**
 * Options for the per-job model dropdown, in display order. The null override
 * ("medium (default)") comes first; explicit "medium" is labelled "(pinned)"
 * to distinguish it — it keeps the job on medium even if the default changes.
 */
export const JOB_MODEL_SELECT_OPTIONS: JobModelSelectOption[] = [
  {
    value: "__default",
    label: "medium (default)",
    description: "Follows the job default — currently medium (Sonnet-class).",
  },
  ...MODEL_CATEGORIES.filter(
    (c): c is ModelCategoryMeta & { value: JobModelCategory } => c.value !== "embedding",
  ).map((c) => ({
    value: c.value,
    label: c.value === "medium" ? "medium (pinned)" : c.value,
    description:
      c.value === "medium"
        ? "Sonnet-class — pins the category even if the job default changes."
        : c.description,
  })),
];
