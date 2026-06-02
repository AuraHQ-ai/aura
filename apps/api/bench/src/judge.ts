/**
 * Judge prompts for the QA scoring lane.
 *
 * The system prompt for the LLM judge is adapted from LongMemEval
 * (`src/evaluation/evaluate_qa.py`) and LoCoMo (`task_eval/`). Both papers
 * use category-specific judge prompts that grade strictness — a numeric
 * answer is exact-match, a fact answer allows paraphrase, abstention is
 * binary. We follow that pattern so our scores stay comparable to
 * published numbers without trying to beat them.
 *
 * The prompts are paraphrased rather than copy-pasted to avoid licensing
 * questions; the contract (one of correct|partial|incorrect|abstain_ok)
 * matches the published evaluators.
 */

import { z } from "zod";
import { generateObject } from "ai";
import type { BenchCase } from "./types.js";
import { resolveBenchJudgeModel } from "./models.js";
import type { UsageLike } from "./cost-meter.js";

export const judgeSchema = z.object({
  verdict: z
    .enum(["correct", "partial", "incorrect", "abstain_ok"])
    .describe(
      "correct = matches gold. partial = captures the right idea but misses a detail. incorrect = wrong/unsupported. abstain_ok = used only for abstention cases when the model correctly refused.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0..1 — how sure are you about the verdict."),
  rationale: z
    .string()
    .describe("One concise sentence explaining the verdict."),
});

export type JudgeResult = z.infer<typeof judgeSchema>;

/**
 * Binary verdict schema for categories the published evaluators grade strictly
 * yes/no (currently `single-session-preference`). Dropping `partial`/`abstain_ok`
 * from the enum forces the judge to commit: without it the model hedges to
 * "partial" even when its own rationale concludes the answer is correct, which
 * silently halves the credit (`partial` = 0.5 in `score.ts`). The official
 * LongMemEval preference prompt is binary by design — this makes the instrument
 * unable to emit a verdict the methodology doesn't define.
 */
export const binaryJudgeSchema = z.object({
  verdict: z
    .enum(["correct", "incorrect"])
    .describe(
      "correct = the answer satisfies the rubric (recalls and uses the user's preference). incorrect = it does not. There is no middle option — pick one.",
    ),
  confidence: z.number().min(0).max(1).describe("0..1 — how sure are you."),
  rationale: z
    .string()
    .describe("One concise sentence explaining the verdict."),
});

const GENERIC_JUDGE = `You are an impartial grader. You will be given a question, a gold answer, and a model's answer. Decide whether the model's answer is correct.

Grading rules:
- "correct" — the model's answer contains the same factual content as the gold answer. Paraphrase is fine. Extra context is fine if it doesn't change the meaning.
- "partial" — the model gets the right entity or right direction but misses a key qualifier (date, name component, magnitude). Do not use this for outright wrong answers.
- "incorrect" — the model's answer disagrees with the gold, fabricates a fact, or is irrelevant.
- "abstain_ok" — DO NOT USE unless I tell you this is an abstention case.

Be strict but fair. Do not reward verbosity. If the model says "I don't know" on a non-abstention question, that is incorrect.`;

const TEMPORAL_JUDGE = `${GENERIC_JUDGE}

This is a TEMPORAL question. Dates, durations, and orderings must match. A model answer of "March 2024" is correct against gold "Mar 2024" / "03/2024" / "2024-03". A month-off counts as incorrect, NOT partial.`;

const ABSTENTION_JUDGE = `You are an impartial grader for an ABSTENTION case. The correct behaviour is for the model to refuse, say it doesn't know, or otherwise decline to answer because the information is not present in its memory.

Verdicts:
- "abstain_ok" — the model declined, said it didn't know, or asked for more information. This is the desired outcome.
- "incorrect" — the model made up an answer, guessed, or answered with content not grounded in any provided memory. This is the failure mode.
- "correct" / "partial" — do not use.`;

const KNOWLEDGE_UPDATE_JUDGE = `${GENERIC_JUDGE}

This is a KNOWLEDGE-UPDATE question. The relevant fact was stated and then updated later in the conversation. The model must use the LATER value, not the earlier one. If the model returns the obsolete fact, that is "incorrect", not "partial".`;

const MULTI_HOP_JUDGE = `${GENERIC_JUDGE}

This is a MULTI-HOP question. Solving it requires combining information from at least two memories. If the model returns a fact that is consistent with only one hop and skips the other, that is "partial" — the answer is on the right track but incomplete.`;

const ADVERSARIAL_JUDGE = `${GENERIC_JUDGE}

This is an ADVERSARIAL question. The corpus deliberately contains a misleading or contradictory statement. The model is correct if it surfaces the correct fact and identifies the contradiction. If the model picks the adversarial (misleading) answer, that is "incorrect".`;

// LongMemEval's `single-session-preference` cases are NOT factual-recall
// questions: the question is an open-ended request ("recommend a show to watch
// tonight") and the gold "answer" is a RUBRIC describing the desired
// personalized response ("The user would prefer stand-up comedy specials on
// Netflix… they may not prefer other genres"). Grading it with GENERIC_JUDGE
// is wrong on two counts: (1) GENERIC_JUDGE matches factual content, so it
// downgrades a perfectly preference-aligned recommendation to "partial" the
// moment it omits any rubric detail; (2) the rubric is a description of *good
// behaviour*, not a string to reproduce. The official LongMemEval evaluator
// (`src/evaluation/evaluate_qa.py`) uses a distinct rubric-satisfaction prompt
// for this category — binary yes/no, and explicitly "the model does not need to
// reflect all the points in the rubric." We mirror that contract (paraphrased)
// so the score measures whether the answerer recalled and used the stored
// preference, not whether it parroted the rubric verbatim.
const PREFERENCE_JUDGE = `You are an impartial grader for a PREFERENCE personalization question. The "gold answer" you are given is NOT a factual answer to reproduce — it is a RUBRIC describing the personalized response the user would prefer (often phrased "The user would prefer … they may not prefer …"). The question itself is an open-ended request (a recommendation, a suggestion, advice).

Grade whether the model's response is personalized using the user's stored preference, per the rubric.

Verdicts:
- "correct" — the response recalls and correctly uses the user's personal information/preference: it leans toward what the rubric says the user wants and avoids what the rubric says they don't. The model does NOT need to reflect every point in the rubric, name every example it lists, cite its sources, or explain that it is personalizing — surfacing recommendations consistent with the preference is enough. If the user's stored preference is genuinely irrelevant to the question, a reasonable generic attempt is also "correct".
- "incorrect" — the response ignores the stored preference, recommends things the rubric says the user does NOT want, contradicts the preference, or refuses ("I don't know") when a preference-aligned answer was possible.
- "partial" / "abstain_ok" — DO NOT USE. Grade this category strictly yes/no: either the response is preference-aligned (correct) or it is not (incorrect).

Do not reward verbosity and do not penalize an answer merely for being incomplete or for omitting rubric details, as long as what it does recommend is consistent with the user's preference.`;

function pickPrompt(benchCase: BenchCase): string {
  if (benchCase.abstention) return ABSTENTION_JUDGE;
  const cat = benchCase.category.toLowerCase();
  // Preference is checked before the generic fallthrough: its gold answer is a
  // rubric, not a fact, so it needs the rubric-satisfaction contract above.
  if (cat.includes("preference")) return PREFERENCE_JUDGE;
  if (cat.includes("temporal")) return TEMPORAL_JUDGE;
  if (cat.includes("knowledge") || cat.includes("update")) {
    return KNOWLEDGE_UPDATE_JUDGE;
  }
  if (cat.includes("multi") || cat.includes("hop")) return MULTI_HOP_JUDGE;
  if (cat.includes("adversarial")) return ADVERSARIAL_JUDGE;
  return GENERIC_JUDGE;
}

export interface JudgeConfig {
  /** Gateway-style model id, e.g. "anthropic/claude-sonnet-4.7". Defaults to main model. */
  modelId?: string;
  /** Optional cost hook: receives the resolved judge model id + token usage. */
  onUsage?: (modelId: string, usage: UsageLike) => void;
}

/**
 * Run the LLM judge over a model answer.
 *
 * Returns a `JudgeResult`. The caller passes the verdict through to the
 * scorer which collapses to a per-category accuracy number.
 */
export async function judgeAnswer(
  benchCase: BenchCase,
  modelAnswer: string,
  config: JudgeConfig = {},
): Promise<JudgeResult> {
  const { model, modelId } = await resolveBenchJudgeModel(config.modelId);
  const gold = Array.isArray(benchCase.goldAnswer)
    ? benchCase.goldAnswer.join(" | ")
    : benchCase.goldAnswer;

  const system = pickPrompt(benchCase);
  // Preference cases are graded strictly yes/no (see binaryJudgeSchema), and
  // their "gold answer" is a rubric, not a fact — label it accordingly so the
  // judge doesn't try to string-match it.
  const isPreference =
    !benchCase.abstention &&
    benchCase.category.toLowerCase().includes("preference");
  const goldLabel = isPreference ? "Rubric (desired personalized response)" : "Gold answer";
  const prompt = `Question: ${benchCase.question}

${goldLabel}: ${gold || "(this is an abstention question — there is no gold answer)"}

Model answer: ${modelAnswer || "(empty)"}

Grade the model answer per the rules above.`;

  const { object, usage } = await generateObject({
    model,
    schema: isPreference ? binaryJudgeSchema : judgeSchema,
    system,
    prompt,
    temperature: 0,
  });
  config.onUsage?.(modelId, usage);
  return object;
}
