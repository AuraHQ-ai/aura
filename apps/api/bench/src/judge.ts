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

/**
 * Verdict type. We grade BINARY (correct/incorrect, plus abstain_ok for
 * abstention cases) to match the published evaluators — official LongMemEval
 * (`evaluate_qa.py`, GPT-4o yes/no) and mem0 (`llm_judge.py`, CORRECT/WRONG).
 * `partial` is retained ONLY in the type for backward-compat with historical
 * `history.jsonl` rows; the judge no longer emits it (the schemas below are
 * binary), so new runs are directly comparable to published numbers instead of
 * silently half-crediting via `partial` = 0.5 in `score.ts`.
 */
export type JudgeResult = {
  verdict: "correct" | "partial" | "incorrect" | "abstain_ok";
  confidence: number;
  rationale: string;
};

/**
 * Binary correctness schema used for ALL non-abstention cases. The published
 * harnesses (LongMemEval, mem0) emit a single yes/no; there is no "partial".
 * Forcing the judge to commit avoids the failure mode where it hedged to
 * `partial` (= 0.5) for a fully-correct answer that merely omitted a peripheral
 * qualifier ("University of Melbourne" vs "…in Australia"), which made our
 * numbers both harsher than and incomparable to the field.
 */
export const binaryJudgeSchema = z.object({
  verdict: z
    .enum(["correct", "incorrect"])
    .describe(
      "correct = conveys the same core answer as the gold (paraphrase, synonyms, extra context, different format, or more/less peripheral detail are all fine). incorrect = wrong/contradictory/fabricated, refuses an answerable question, or misses the asked-for fact. No middle option — pick one.",
    ),
  confidence: z.number().min(0).max(1).describe("0..1 — how sure are you."),
  rationale: z
    .string()
    .describe("One concise sentence explaining the verdict."),
});

/** Abstention schema: the desired behaviour is to refuse, so the only verdicts
 * are abstain_ok (refused correctly) / incorrect (answered when it shouldn't). */
export const abstentionJudgeSchema = z.object({
  verdict: z
    .enum(["abstain_ok", "incorrect"])
    .describe(
      "abstain_ok = the model declined / said it didn't know / asked for more info. incorrect = it fabricated or guessed an answer. Pick one.",
    ),
  confidence: z.number().min(0).max(1).describe("0..1 — how sure are you."),
  rationale: z
    .string()
    .describe("One concise sentence explaining the verdict."),
});

// Binary + lenient grading, mirroring the official LongMemEval evaluator
// (gpt-4o yes/no, 97% human agreement) and mem0's llm_judge (CORRECT/WRONG).
// The published consensus is explicitly GENEROUS: an answer that conveys the
// same core fact counts, regardless of paraphrase, verbosity, extra context, or
// omitted peripheral qualifiers. We do NOT dock for "University of Melbourne"
// vs "University of Melbourne in Australia" or "Atheism" vs "a staunch atheist".
const GENERIC_JUDGE = `You are an impartial grader. You will be given a question, a gold answer, and a model's answer. Decide whether the model's answer is correct, grading the way the LongMemEval / mem0 evaluators do: a single yes/no, and GENEROUS.

Grading rules:
- "correct" — the model's answer conveys the same core fact/answer as the gold. Be generous: paraphrases, synonyms, extra surrounding context, a more verbose or more terse phrasing, and different formats all count. Do NOT penalize for omitting a peripheral qualifier the gold happens to include (e.g. "University of Melbourne" for gold "University of Melbourne in Australia", or "Atheism" for "a staunch atheist") — if the central answer is right, it is correct.
- "incorrect" — the model states a different or contradictory fact, fabricates, is irrelevant, misses the specific fact the question asks for, or refuses ("I don't know") on a question that is answerable from memory.

Pick exactly one. Do not reward verbosity, but do not punish it either; judge only whether the core answer matches.`;

const TEMPORAL_JUDGE = `${GENERIC_JUDGE}

This is a TEMPORAL question. Judge the date/duration/ordering, not the format: "March 2024" = "Mar 2024" = "03/2024" = "2024-03", and "last Tuesday" matching the right calendar date is correct. A genuinely different date or duration is incorrect.`;

const ABSTENTION_JUDGE = `You are an impartial grader for an ABSTENTION case. The correct behaviour is for the model to refuse, say it doesn't know, or otherwise decline to answer because the information is not present in its memory.

Verdicts:
- "abstain_ok" — the model declined, said it didn't know, or asked for more information. This is the desired outcome.
- "incorrect" — the model made up an answer, guessed, or answered with content not grounded in any provided memory. This is the failure mode.`;

const KNOWLEDGE_UPDATE_JUDGE = `${GENERIC_JUDGE}

This is a KNOWLEDGE-UPDATE question. The relevant fact was stated and then updated later in the conversation. The model must use the LATER (current) value. Returning the obsolete earlier value is incorrect.`;

const MULTI_HOP_JUDGE = `${GENERIC_JUDGE}

This is a MULTI-HOP question requiring information combined from at least two memories. It is "correct" only if the model reaches the right final answer; an answer that reflects only one hop and omits a required operand is "incorrect".`;

const ADVERSARIAL_JUDGE = `${GENERIC_JUDGE}

This is an ADVERSARIAL question: the corpus deliberately contains a misleading or contradictory statement. The model is "correct" if it surfaces the right fact (or resists the false premise); picking the misleading answer is "incorrect".`;

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
  // Preference cases' "gold answer" is a rubric, not a fact — label it so the
  // judge doesn't try to string-match it.
  const isPreference =
    !benchCase.abstention &&
    benchCase.category.toLowerCase().includes("preference");
  const goldLabel = isPreference ? "Rubric (desired personalized response)" : "Gold answer";
  const prompt = `Question: ${benchCase.question}

${goldLabel}: ${gold || "(this is an abstention question — there is no gold answer)"}

Model answer: ${modelAnswer || "(empty)"}

Grade the model answer per the rules above.`;

  // Binary everywhere, matching the published evaluators: abstention uses the
  // abstain_ok/incorrect schema; every other category (factual, temporal,
  // knowledge-update, multi-hop, adversarial, preference) uses correct/incorrect.
  const schema = benchCase.abstention ? abstentionJudgeSchema : binaryJudgeSchema;
  const { object, usage } = await generateObject({
    model,
    schema,
    system,
    prompt,
    temperature: 0,
  });
  config.onUsage?.(modelId, usage);
  return object as JudgeResult;
}
