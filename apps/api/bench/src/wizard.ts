/**
 * Guided interactive setup for the memory bench.
 *
 * Walks a first-time user through the handful of choices that matter (which
 * corpus, how many cases, replay cadence, whether to reuse prior data) with a
 * one-line explanation per step, then hands back a `BenchRunConfig` partial AND
 * the equivalent `pnpm bench:memory …` command so they learn the flags.
 *
 * Runs BEFORE the Ink dashboard mounts (sequential `@inquirer/prompts`), so the
 * two TUIs never fight over the terminal. Only triggered on `--interactive`/`-i`
 * or when stdout is a TTY and no meaningful flags were passed — CI always passes
 * flags, so it never fires there.
 */

import { select, number, confirm } from "@inquirer/prompts";
import type { BenchRunConfig, DatasetId } from "./types.js";

export interface WizardResult {
  cfg: Partial<BenchRunConfig>;
  /** The equivalent flag command, echoed so users learn the CLI. */
  command: string;
}

export async function runWizard(): Promise<WizardResult> {
  console.log("\n🧪  Memory bench — interactive setup\n");

  const datasetChoice = await select<"both" | "lme" | "locomo" | "toy">({
    message: "Which corpus to score against?",
    choices: [
      { name: "LongMemEval  — long-conversation QA (recommended)", value: "lme" },
      { name: "LoCoMo       — multi-session dialogue QA", value: "locomo" },
      { name: "Both         — LoCoMo + LongMemEval", value: "both" },
      { name: "Toy          — tiny built-in set (smoke test, ~free)", value: "toy" },
    ],
    default: "lme",
  });

  const datasets: DatasetId[] =
    datasetChoice === "both"
      ? ["locomo", "longmemeval"]
      : datasetChoice === "lme"
        ? ["longmemeval"]
        : datasetChoice === "locomo"
          ? ["locomo"]
          : ["toy"];

  const casesCount = await number({
    message: "How many total cases? (more = slower + costlier; blank = subset default)",
    default: 2,
    min: 1,
  });

  const replay = await select<"session" | "exchange">({
    message: "Extraction replay cadence?",
    choices: [
      { name: "session   — one extraction per session (cheap, default)", value: "session" },
      { name: "exchange  — one per assistant turn; mirrors prod, ~N× costlier", value: "exchange" },
    ],
    default: "session",
  });

  const reuse = await select<"fresh" | "reuse-messages" | "reuse-memories">({
    message: "Reuse data from a prior run?",
    choices: [
      { name: "No, start fresh        — wipe + run all stages (messages→extract→score)", value: "fresh" },
      { name: "Reuse messages         — re-extract memories + score (--from=extract)", value: "reuse-messages" },
      { name: "Reuse memories         — only re-run retrieval + QA (--from=score)", value: "reuse-memories" },
    ],
    default: "fresh",
  });

  const advanced = await confirm({
    message: "Configure advanced options (category filter, model overrides)?",
    default: false,
  });

  let category: string | undefined;
  let extractionModel: string | undefined;
  let answererModel: string | undefined;
  let judgeModel: string | undefined;
  if (advanced) {
    const catRaw = await select<string>({
      message: "Category filter?",
      choices: [
        { name: "(all categories)", value: "" },
        { name: "temporal", value: "temporal" },
        { name: "multi_hop", value: "multi_hop" },
        { name: "knowledge_update", value: "knowledge_update" },
        { name: "abstention", value: "abstention" },
      ],
      default: "",
    });
    category = catRaw || undefined;
    const modelRaw = await select<string>({
      message: "Model tier for extraction + answerer?",
      choices: [
        { name: "default (main / escalation judge)", value: "" },
        { name: "fast  — production extraction tier / cheapest", value: "fast" },
        { name: "main  — stronger, slower", value: "main" },
      ],
      default: "",
    });
    if (modelRaw) {
      extractionModel = modelRaw;
      answererModel = modelRaw;
    }
    void judgeModel;
  }

  const fromStage =
    reuse === "reuse-memories"
      ? ("score" as const)
      : reuse === "reuse-messages"
        ? ("extract" as const)
        : undefined;
  const reset = reuse === "fresh";

  const cfg: Partial<BenchRunConfig> = {
    datasets,
    subset: "fast",
    cases: casesCount && casesCount > 0 ? casesCount : undefined,
    category,
    replay,
    fromStage,
    reset,
    extractionModel,
    answererModel,
    judgeModel,
  };

  // Build the equivalent flag command so the user learns the CLI.
  const flags: string[] = [`--dataset=${datasetChoice}`];
  if (cfg.cases) flags.push(`--cases=${cfg.cases}`);
  if (replay === "exchange") flags.push("--per-exchange");
  if (reset) flags.push("--reset");
  if (fromStage) flags.push(`--from=${fromStage}`);
  if (category) flags.push(`--category=${category}`);
  if (extractionModel) flags.push(`--extraction-model=${extractionModel}`);
  const command = `pnpm bench:memory ${flags.join(" ")}`;

  console.log(`\n▶  Running. Equivalent command:\n   ${command}\n`);

  return { cfg, command };
}
