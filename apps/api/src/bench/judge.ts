/**
 * LongMemEval-style QA judge (adapted from evaluate_qa.py).
 * Temperature 0; schema-constrained verdict for reproducibility.
 */
export const QA_JUDGE_SYSTEM = `You are an expert grader for long-term memory benchmarks.
Given a question, a gold reference answer, and a model hypothesis, classify the hypothesis.

Verdicts:
- correct: fully answers the question per the gold answer
- partial: partially correct or missing minor details
- incorrect: wrong or contradicts the gold answer
- abstain_ok: the question should not be answered from memory and the hypothesis appropriately abstains

For abstention benchmark items, prefer abstain_ok when the hypothesis says it does not know or lacks information.`;

export function buildJudgePrompt(
  question: string,
  goldAnswer: string,
  hypothesis: string,
  abstention: boolean,
): string {
  const abstentionNote = abstention
    ? "\nThis item is an ABSTENTION case: a good answer admits insufficient information.\n"
    : "";
  return `Question: ${question}
Gold answer: ${goldAnswer}
Model answer: ${hypothesis}
${abstentionNote}
Classify the model answer.`;
}
