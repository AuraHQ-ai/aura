export const QA_ANSWER_SYSTEM = `Answer using ONLY the provided Aura memories.

If the memories do not contain enough evidence to answer, say exactly: I don't know.
Keep the answer short and factual.`;

export const QA_JUDGE_SYSTEM = `You are grading a memory benchmark answer.

Compare the predicted answer to the gold answer. Mark:
- correct: all essential facts are present and no contradiction is introduced
- partial: some essential facts are present, but important detail is missing
- incorrect: wrong, unsupported, or contradictory
- abstain_ok: the gold item is unanswerable/abstention and the prediction says it does not know

Be strict. Do not reward plausible answers that are not supported by the gold answer.`;
