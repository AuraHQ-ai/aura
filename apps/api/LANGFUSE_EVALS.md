# Langfuse Evals — should-respond gate (template)

A lightweight, repeatable template for scoring the quality of Aura's
`should-respond` gate (the Haiku call in
[`src/pipeline/context.ts`](src/pipeline/context.ts) that decides RESPOND vs
SKIP). Use it as the pattern for any future evaluator.

This is **not wired into the request path** — it runs inside Langfuse against
already-exported traces.

## Prerequisites

```bash
# Load keys (repo root)
set -a; source <(grep -i LANGFUSE .env.local); set +a
```

Running an LLM-as-judge also requires an **LLM connection** in the Langfuse
project (Settings -> LLM Connections) and a project default eval model, or an
explicit `--modelConfig` on the evaluator. Without it, evaluator creation fails
preflight with `code=evaluator_preflight_failed`.

## 1. Score config (already created)

Boolean score `should_respond_correct` (true = the gate decided correctly):

```bash
npx --yes langfuse-cli api score-configs create \
  --name "should_respond_correct" \
  --dataType "BOOLEAN" \
  --description "Whether Aura's should-respond gate (RESPOND/SKIP) made the correct decision for the given conversation."
```

Created config id: `4a5066b2-3202-419c-8e38-825e01b8e0ad` (project `cmq5mlke0005yad0culhatfqr`).

## 2. LLM-as-judge evaluator

The gate observation's **input** is the conversation + latest message; its
**output** is `RESPOND` or `SKIP`. The judge reads both and scores correctness.

```bash
npx --yes langfuse-cli api unstable-evaluators create \
  --name "should-respond-correctness" \
  --prompt "$(cat <<'PROMPT'
You are auditing an AI assistant's "should I respond?" gate inside a Slack workspace.

The assistant (Aura) only responds when she is genuinely addressed or can add clear value; otherwise she stays silent to avoid being noisy. Over-responding (barging in) and under-responding (missing a real request) are both failures.

Conversation and latest message that the gate saw:
{{input}}

The gate's decision:
{{output}}

Decide whether the gate's decision was correct for this conversation.
- Return score = 1 (true) if the decision was correct (responded when warranted, or skipped when not).
- Return score = 0 (false) if it was wrong (barged in, or missed a clear request/mention).
Give a one-sentence reason.
PROMPT
)" \
  --outputDefinition.dataType "BOOLEAN" \
  --outputDefinition.reasoning.description "One sentence explaining why the decision was correct or incorrect." \
  --outputDefinition.score "1 if the gate decision was correct, 0 if incorrect." \
  --modelConfig.provider "anthropic" \
  --modelConfig.model "claude-haiku-4-5"
```

Note the returned `variables` array (`input`, `output`) — the rule in step 3
must map every one of them.

## 3. Evaluation rule (what to score, sampled)

Target the `should-respond` generations and sample a fraction so judge cost stays
small. The CLI exposes the core fields; the **filter** (trace name =
`should-respond`) and the **variable mapping** (`input`/`output` ->
observation input/output) are easiest to finish in the UI
(Evaluations -> New rule -> pick `should-respond-correctness`).

```bash
npx --yes langfuse-cli api unstable-evaluation-rules create \
  --name "should-respond-correctness-prod" \
  --target "observation" \
  --evaluator.name "should-respond-correctness" \
  --evaluator.scope "project" \
  --sampling 0.15 \
  --enabled
```

After creation, in the rule's UI:
- Filter: observation `name` = `should-respond` (and `environment` = `production`).
- Map prompt variable `input` -> observation Input, `output` -> observation Output.

## 4. (Optional) Human ground truth via annotation queue

To calibrate the judge against human labels, queue ~50 `should-respond` traces.

> Queues cannot be deleted or reconfigured after creation — create the score
> config first (done above), then the queue referencing it.

```bash
# Create the queue (capture its id from the response)
npx --yes langfuse-cli api annotation-queues create \
  --name "should-respond ground truth" \
  --description "Human pass/fail labels for the should-respond gate to calibrate the LLM judge."

# Add a sample of should-respond observations as queue items (objectType=OBSERVATION)
# Pull recent should-respond observation ids, then for each:
#   npx --yes langfuse-cli api annotation-queues post-create-queue-item <queue-id> \
#     --objectId <observationId> --objectType OBSERVATION
# Add `sleep 0.4` between calls to avoid 429s.
```

Then compare the human labels to the `should_respond_correct` judge scores to
measure judge accuracy before trusting it. See the `langfuse` skill's
`references/judge-calibration.md` for the full split-based calibration workflow.
